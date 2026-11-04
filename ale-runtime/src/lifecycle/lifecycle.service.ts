import {Logger} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {ComputeError} from '../compute/compute-client';
import {mergeMetadata, MetadataMergeError} from '../compute/metadata';
import type {AssistantStateV1} from '../contracts/v1';
import {ServiceError, serviceUnavailable} from '../domain/errors';
import type {AssistantRepository, AssistantRow, CauseCode} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import {NO_ASSISTANT, toAssistantState} from '../state/assistant-state';
import type {LifecycleCredentials} from './lifecycle-credentials';
import type {LifecycleComputeApi} from './lifecycle-compute';
import type {LifecycleStore} from './lifecycle-store';
import {archiveObjectName, ArchiveError, type MemoryArchiver} from './memory-archive';

export const LIFECYCLE_SERVICE = Symbol('LIFECYCLE_SERVICE');

export interface LifecycleOptions {
  /** Bucket de memorias (saleads-dev-assistant-memories). */
  bucket: string;
  /** Vigencia de la signed URL (15 min). */
  archiveUrlTtlSeconds: number;
  /** Cuánto se espera el objeto en el bucket antes de declarar archive_failed (10 min). */
  archiveTimeoutMs: number;
  /** Cuánto se espera el 404 de la VM tras instances.delete. */
  deleteTimeoutMs: number;
  /** Cuánto se siguen las operaciones de stop/start. */
  operationTimeoutMs: number;
  pollIntervalMs: number;
}

export interface LifecycleDeps {
  repository: AssistantRepository;
  store: LifecycleStore;
  compute: LifecycleComputeApi;
  archiver: MemoryArchiver;
  cipher: FieldCipher;
  /** Revoke RFC 7009 y renovación antes del start: `CredentialRenewal` de OCB-009. */
  credentials: LifecycleCredentials;
  /**
   * Aplica `hermes-config` desde la fila con la VM aún apagada (OCB-016: una
   * zona cambiada mientras estaba apagada). Nunca lanza; se acota con el mismo
   * presupuesto que la renovación.
   */
  config?: {syncBeforeStart(userId: string): Promise<void>};
  /** Cuánto se espera la renovación previa al start antes de encender igual (no bloquea). */
  renewBeforeStartBudgetMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const STOPPED_STATES = new Set(['TERMINATED', 'STOPPED']);
const ARCHIVE_STATUS = /^(uploaded:[a-f0-9]{1,64}|failed:[0-9]{1,3})$/;

/** Prefijo de hash que publica el watcher en `hermes/archive-status=uploaded:<hash12>`. */
export const archiveUrlHash = (url: string) => createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 12);

const computeDetail = (error: unknown): string =>
  error instanceof ComputeError ? `status=${error.status} reason=${error.reason}`
    : error instanceof ArchiveError || error instanceof MetadataMergeError ? `reason=${error.reason}`
      : 'reason=other';

/**
 * Desactivar, reactivar y borrar (OCB-012, OCM-008).
 *
 * - stop: `instances.stop` → status=stopped (la VM queda TERMINATED, el disco y
 *   /opt/data intactos).
 * - start: `instances.start` → status=activating, step=preparing_environment.
 *   La IP privada se relee al terminar la operación; installing_agent →
 *   configure_ai/ready lo resuelve la readiness de OCB-008.
 * - DELETE: responde `deleting` y sigue en segundo plano (secuencia en
 *   `runDeletion`). El front sondea GET /me hasta `none`.
 *
 * Los logs y eventos solo llevan nombres de VM, códigos y contadores; nunca la
 * signed URL, tokens ni el API_SERVER_KEY.
 */
export class LifecycleService {
  private readonly logger = new Logger('lifecycle');
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Set<Promise<void>>();
  /** Un borrado en curso por usuario dentro de este proceso. */
  private readonly deleting = new Set<string>();

  constructor(private readonly options: LifecycleOptions, private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
  }

  /** `POST /assistants/me/stop`. Fuera de ready/instalado responde el estado actual sin cambios. */
  async stop(userId: string): Promise<AssistantStateV1> {
    const row = await this.requireRow(userId);
    if (!this.canStop(row)) return toAssistantState(row, this.now());
    const name = row.instance_name!;
    let operation: string;
    try {
      operation = await this.deps.compute.stopInstance(name);
    } catch (error) {
      await this.event(userId, 'vm.stop_failed', 'stop', 'vm_stop_failed', computeDetail(error));
      this.logger.warn(`vm stop failed instance=${name} ${computeDetail(error)}`);
      throw serviceUnavailable();
    }
    const moved = await this.deps.store.markStopped(userId, this.now());
    if (!moved) return toAssistantState(await this.deps.repository.findActive(userId), this.now());
    await this.event(userId, 'vm.stop_requested', 'stop');
    this.logger.log(`vm stop requested instance=${name}`);
    this.background(this.followStop(userId, name, operation, moved.previousStatus, moved.previousStep));
    return toAssistantState(moved.row, this.now());
  }

  /** `POST /assistants/me/start`. Solo desde stopped; en otro estado responde el actual. */
  async start(userId: string): Promise<AssistantStateV1> {
    const row = await this.requireRow(userId);
    if (row.status !== 'stopped' || !row.instance_name) return toAssistantState(row, this.now());
    const name = row.instance_name;
    let operation: string;
    await this.renewBeforeStart(userId);
    await this.syncConfigBeforeStart(userId);
    try {
      operation = await this.deps.compute.startInstance(name);
    } catch (error) {
      await this.event(userId, 'vm.start_failed', 'start', 'vm_start_failed', computeDetail(error));
      this.logger.warn(`vm start failed instance=${name} ${computeDetail(error)}`);
      throw serviceUnavailable();
    }
    const moved = await this.deps.store.markStarting(userId, this.now());
    if (!moved) return toAssistantState(await this.deps.repository.findActive(userId), this.now());
    await this.event(userId, 'vm.start_requested', 'start');
    this.logger.log(`vm start requested instance=${name}`);
    this.background(this.followStart(userId, name, operation));
    return toAssistantState(moved.row, this.now());
  }

  /**
   * `DELETE /assistants/me`. Idempotente: sin asistente responde `none`; si ya
   * se está borrando en este proceso responde `deleting` sin lanzar otro.
   */
  async remove(userId: string): Promise<AssistantStateV1> {
    const moved = await this.deps.store.markDeleting(userId, this.now());
    if (!moved) return NO_ASSISTANT;
    if (moved.previousStatus !== 'deleting') {
      await this.event(userId, 'delete.requested', 'delete', null, `from=${moved.previousStatus}`);
    }
    this.launchDeletion(userId);
    return toAssistantState(moved.row, this.now());
  }

  /** Reanuda los borrados que quedaron en `deleting` (llamar al arrancar el servicio). */
  async resumePendingDeletions(): Promise<number> {
    const users = await this.deps.store.pendingDeletions();
    for (const userId of users) this.launchDeletion(userId);
    return users.length;
  }

  /** Espera los trabajos en segundo plano (pruebas y apagado ordenado). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private launchDeletion(userId: string): void {
    if (this.deleting.has(userId)) return;
    this.deleting.add(userId);
    this.background(this.runDeletion(userId).finally(() => this.deleting.delete(userId)));
  }

  /**
   * Secuencia de borrado (OCB-012, precisiones de la auditoría):
   * 1. Si la VM existe: signed URL V4 (PUT, application/gzip) a
   *    gs://<bucket>/<user_id>/<ts>.tgz → setMetadata hermes-archive-url con
   *    fingerprint (merge de TODA la metadata) → si está apagada, se enciende
   *    para que el watcher suba → se sondea el objeto hasta el timeout.
   *    Sin objeto: evento archive_failed, status=failed, la VM se conserva y
   *    termina aquí (un DELETE nuevo reintenta con otra URL).
   * 2. instances.delete y espera del 404 (el disco se borra con la VM).
   * 3. Revoke RFC 7009 con el refresh guardado: un fallo se registra y no bloquea.
   * 4. Borra assistant_credentials y oauth_flows.
   * 5. deleted_at=now() → GET /me responde status=none.
   */
  private async runDeletion(userId: string): Promise<void> {
    const row = await this.deps.repository.findActive(userId);
    if (!row || row.status !== 'deleting') return;
    const name = row.instance_name;
    let archive = 'skipped:no_instance';

    if (name) {
      let instance;
      try {
        instance = await this.deps.compute.instanceInfo(name);
      } catch (error) {
        return this.deletionFailed(userId, 'archive_failed', 'inspect', 'archive_failed', computeDetail(error));
      }
      if (instance) {
        const archived = await this.archive(userId, name);
        if (!archived.ok) return this.deletionFailed(userId, 'archive_failed', 'archive', 'archive_failed', archived.detail);
        archive = `object=${archived.object.split('/').pop()}`;
        const deleted = await this.deleteVm(name);
        if (!deleted.ok) return this.deletionFailed(userId, 'vm.delete_failed', 'delete_vm', 'vm_delete_failed', deleted.detail);
        await this.event(userId, 'vm.deleted', 'delete_vm');
        this.logger.log(`vm deleted instance=${name}`);
      } else {
        await this.event(userId, 'archive.skipped', 'archive', null, 'reason=no_instance');
      }
    } else {
      await this.event(userId, 'archive.skipped', 'archive', null, 'reason=no_instance');
    }

    await this.revoke(userId);
    await this.deps.store.deleteCredentials(userId);
    if (await this.deps.store.finalizeDeletion(userId, this.now())) {
      await this.event(userId, 'assistant.deleted', 'delete', null, archive);
      this.logger.log(`assistant deleted ${name ? `instance=${name} ` : ''}${archive}`);
    }
  }

  private async archive(userId: string, name: string): Promise<{ok: true; object: string} | {ok: false; detail: string}> {
    const {compute, archiver} = this.deps;
    const {bucket} = this.options;
    const now = this.now();
    const object = archiveObjectName(userId, now);
    let expectedHash: string;
    try {
      const url = await archiver.signedUploadUrl({bucket, object, now, ttlSeconds: this.options.archiveUrlTtlSeconds});
      expectedHash = archiveUrlHash(url);
      await this.writeArchiveUrl(name, url);
    } catch (error) {
      return {ok: false, detail: `phase=request ${computeDetail(error)}`};
    }
    await this.event(userId, 'archive.requested', 'archive', null, `object=${object.split('/').pop()}`);
    this.logger.log(`archive requested instance=${name}`);

    const deadline = now.getTime() + this.options.archiveTimeoutMs;
    let started = false;
    let lastStatus = 'none';
    let lastError = '';
    for (;;) {
      try {
        if (await archiver.objectExists(bucket, object)) {
          await this.event(userId, 'archive.uploaded', 'archive', null, `object=${object.split('/').pop()}`);
          this.logger.log(`archive uploaded instance=${name}`);
          return {ok: true, object};
        }
        const instance = await compute.instanceInfo(name);
        if (!instance) return {ok: false, detail: 'reason=instance_gone'};
        if (!started && STOPPED_STATES.has(instance.status)) {
          // Apagada (desactivada): se enciende solo para que el watcher suba el archivo.
          await compute.startInstance(name);
          started = true;
          await this.event(userId, 'archive.vm_started', 'archive');
        }
        if (instance.status === 'RUNNING') {
          const status = await compute.guestAttribute(name, 'hermes', 'archive-status');
          if (status && ARCHIVE_STATUS.test(status)) {
            lastStatus = status.startsWith('uploaded:') && status !== `uploaded:${expectedHash}` ? 'uploaded_other' : status;
          }
        }
        lastError = '';
      } catch (error) {
        lastError = ` last_error=${computeDetail(error).replace(/ /g, ',')}`;
      }
      if (this.now().getTime() >= deadline) return {ok: false, detail: `reason=timeout last_status=${lastStatus}${lastError}`};
      await this.sleep(this.options.pollIntervalMs);
    }
  }

  /** setMetadata con fingerprint: fusiona TODA la metadata actual + hermes-archive-url. Un 412 se reintenta una vez. */
  private async writeArchiveUrl(name: string, url: string): Promise<void> {
    const {compute} = this.deps;
    for (let tries = 1; ; tries++) {
      const instance = await compute.instanceInfo(name);
      if (!instance) throw new ComputeError(404, 'notFound');
      try {
        const operation = await compute.replaceMetadata(name, instance.fingerprint, mergeMetadata(instance.items, {'hermes-archive-url': url}));
        const done = await this.waitOperation(operation);
        if (done.ok) return;
        throw new ComputeError(0, done.reason);
      } catch (error) {
        const conflict = error instanceof ComputeError && (error.status === 412 || error.reason === 'conditionNotMet');
        if (!conflict || tries >= 2) throw error;
      }
    }
  }

  private async deleteVm(name: string): Promise<{ok: true} | {ok: false; detail: string}> {
    const {compute} = this.deps;
    try {
      const operation = await compute.deleteInstance(name);
      if (operation === null) return {ok: true};
    } catch (error) {
      return {ok: false, detail: computeDetail(error)};
    }
    const deadline = this.now().getTime() + this.options.deleteTimeoutMs;
    let lastError = '';
    for (;;) {
      try {
        if (!(await compute.instanceInfo(name))) return {ok: true};
        lastError = '';
      } catch (error) {
        lastError = ` last_error=${computeDetail(error).replace(/ /g, ',')}`;
      }
      if (this.now().getTime() >= deadline) return {ok: false, detail: `reason=timeout${lastError}`};
      await this.sleep(this.options.pollIntervalMs);
    }
  }

  /** Revoke de OCB-009: nunca lanza y registra sus eventos; un fallo no bloquea el borrado. */
  private async revoke(userId: string): Promise<void> {
    let outcome;
    try {
      outcome = await this.deps.credentials.revokeStoredCredential(userId);
    } catch {
      outcome = {result: 'failed' as const, reason: 'other'};
      await this.event(userId, 'credential.revoke_failed', 'revoke', 'revoke_failed', 'reason=other');
    }
    if (outcome.result === 'no_credential') await this.event(userId, 'credential.revoke_skipped', 'revoke', null, 'reason=no_credential');
    if (outcome.result === 'failed') this.logger.warn(`revoke failed reason=${outcome.reason}`);
  }

  /**
   * Renovación previa al start (OCB-009). Se espera como mucho
   * `renewBeforeStartBudgetMs` (el BFF corta a 15 s); si falla o tarda, se
   * enciende igual: Hermes renueva solo y el barrido de OCB-009 reintenta.
   */
  private async renewBeforeStart(userId: string): Promise<void> {
    const budget = this.deps.renewBeforeStartBudgetMs ?? 5_000;
    const renewal = this.deps.credentials.renewBeforeStart(userId).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([renewal, new Promise(resolve => {timer = setTimeout(resolve, budget); timer.unref();})]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Config pendiente antes del start (OCB-016). Si tarda más que el
   * presupuesto, se enciende igual: el watcher aplica el cambio cuando llegue.
   */
  private async syncConfigBeforeStart(userId: string): Promise<void> {
    if (!this.deps.config) return;
    const budget = this.deps.renewBeforeStartBudgetMs ?? 5_000;
    const sync = this.deps.config.syncBeforeStart(userId).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([sync, new Promise(resolve => {timer = setTimeout(resolve, budget); timer.unref();})]);
    if (timer) clearTimeout(timer);
  }

  private async deletionFailed(userId: string, kind: string, phase: string, cause: CauseCode, detail: string): Promise<void> {
    await this.event(userId, kind, phase, cause, detail);
    await this.deps.store.markDeleteFailed(userId, this.now());
    this.logger.warn(`delete stopped kind=${kind} ${detail}`);
  }

  private async followStop(userId: string, name: string, operation: string, previousStatus: AssistantRow['status'], previousStep: AssistantRow['step']): Promise<void> {
    const done = await this.waitOperation(operation);
    if (done.ok) {
      await this.event(userId, 'vm.stopped', 'stop');
      return;
    }
    if (done.reason === 'timeout') return;
    await this.event(userId, 'vm.stop_failed', 'stop', 'vm_stop_failed', `reason=${done.reason}`);
    await this.deps.store.revertStop(userId, previousStatus, previousStep, this.now());
    this.logger.warn(`vm stop failed instance=${name} reason=${done.reason}`);
  }

  private async followStart(userId: string, name: string, operation: string): Promise<void> {
    const done = await this.waitOperation(operation);
    if (!done.ok && done.reason !== 'timeout') {
      await this.event(userId, 'vm.start_failed', 'start', 'vm_start_failed', `reason=${done.reason}`);
      await this.deps.store.revertStart(userId, this.now());
      this.logger.warn(`vm start failed instance=${name} reason=${done.reason}`);
      return;
    }
    try {
      const instance = await this.deps.compute.instanceInfo(name);
      if (instance?.privateIp) await this.deps.store.savePrivateIp(userId, instance.privateIp, this.now());
      if (done.ok) await this.event(userId, 'vm.started', 'start');
    } catch (error) {
      this.logger.warn(`vm ip read failed instance=${name} ${computeDetail(error)}`);
    }
  }

  /** Sigue una operación zonal hasta DONE, acotado. */
  private async waitOperation(operation: string): Promise<{ok: true} | {ok: false; reason: string}> {
    const deadline = this.now().getTime() + this.options.operationTimeoutMs;
    for (;;) {
      try {
        const status = await this.deps.compute.operationStatus(operation);
        if (status.done) return status.errorReason ? {ok: false, reason: status.errorReason} : {ok: true};
      } catch (error) {
        if (!(error instanceof ComputeError)) return {ok: false, reason: 'other'};
      }
      if (this.now().getTime() >= deadline) return {ok: false, reason: 'timeout'};
      await this.sleep(this.options.pollIntervalMs);
    }
  }

  private canStop(row: AssistantRow): boolean {
    if (!row.instance_name) return false;
    return row.status === 'ready' || (row.status === 'activating' && (row.step === 'installing_agent' || row.step === 'configure_ai'));
  }

  private async requireRow(userId: string): Promise<AssistantRow> {
    const row = await this.deps.repository.findActive(userId);
    if (!row) throw new ServiceError('NOT_FOUND', 404);
    return row;
  }

  private event(userId: string, kind: string, phase: string, cause: CauseCode | null = null, detail: string | null = null): Promise<void> {
    return this.deps.repository.appendEvent({userId, kind, phase, cause, detail});
  }

  private background(work: Promise<void>): void {
    const run = work.catch(error => {
      this.logger.warn(`lifecycle job aborted kind=${error instanceof Error ? error.name : typeof error}`);
    }).finally(() => this.pending.delete(run));
    this.pending.add(run);
  }
}
