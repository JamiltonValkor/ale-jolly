import {Logger} from '@nestjs/common';
import {randomBytes} from 'node:crypto';
import {ComputeError, type ComputeApi} from '../compute/compute-client';
import {insertRequestId, instanceNameFor} from '../compute/instance-name';
import {mergeMetadata, MetadataMergeError, type HermesMetadata} from '../compute/metadata';
import {ArchiveError} from '../lifecycle/memory-archive';
import {OAuthTokenError, type AssistantTokenSet, type OAuthTokenApi} from '../oauth/token-client';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import {hermesMcpTokens, initialHermesMetadata, type AgentBundle, type McpConfig} from './hermes-files';

export interface ProvisionerOptions {
  zone: string;
  /** Separate deployments must also use independent database, OAuth and storage. */
  runtimeNamespace?: string;
  issuer: string;
  mcp: McpConfig;
  bundle: AgentBundle;
  /** ORQA cliente (OSB-009): imagen privada del cerebro (`hermes-brain-image`); vacío = sin cerebro. */
  brainImage?: string | null;
  /** Fixed managed Meta plugin/exporter archive; omitted by the classical deployment. */
  managedMetaExtensions?: string;
  operationTimeoutMs: number;
  retryDelayMs: number;
  /** Intervalo de sondeo de la operación de insert. */
  pollIntervalMs?: number;
}

/**
 * GET firmado del último archivo de memorias del usuario (D50); null = no hay
 * archivo. Es una credencial de lectura: nunca va a logs ni a eventos.
 */
export type RestoreUrlSource = (userId: string, now: Date) => Promise<string | null>;

export interface ProvisionerDeps {
  repository: AssistantRepository;
  /** Sin fuente (pruebas, otros ambientes) la VM nace sin `hermes-restore-url`. */
  restoreUrl?: RestoreUrlSource;
  compute: ComputeApi;
  tokens: OAuthTokenApi;
  cipher: FieldCipher;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

type AttemptOutcome = {ok: true; result: 'created' | 'exists' | 'pending'} | {ok: false; phase: string; detail: string};

const MAX_ATTEMPTS = 2;

/**
 * Crea la VM del usuario desde la plantilla (OCB-007). Corre en segundo plano
 * tras el callback OAuth (el BFF espera ≤15 s), o al reanudar una activación.
 *
 * 1. Reclama la creación en la fila (un solo ganador → un solo insert).
 * 2. Genera el API_SERVER_KEY y la metadata hermes-*, con `hermes-restore-url`
 *    si el usuario tiene un archivo de memorias de una VM anterior (D50).
 * 3. GET de la plantilla + merge por clave + instances.insert con
 *    sourceInstanceTemplate; 409 alreadyExists = ya existe.
 * 4. Sigue la operación hasta DONE (acotado). Un fallo reintenta UNA vez; el
 *    segundo deja status=failed sin borrar nada, con la causa en assistant_events.
 *
 * Los logs solo llevan el nombre de la VM, el intento y códigos.
 */
export class Provisioner {
  private readonly logger = new Logger('provisioner');
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ProvisionerOptions, private readonly deps: ProvisionerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
  }

  /** Lanza la creación sin esperarla. `tokens` = los del canje recién hecho; null = refrescar los guardados. */
  start(userId: string, tokens: AssistantTokenSet | null): void {
    const run = this.provision(userId, tokens).catch(error => {
      this.logger.warn(`provisioning aborted kind=${error instanceof Error ? error.name : typeof error}`);
    }).finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  /** Espera las creaciones en curso (apagado ordenado y pruebas). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async provision(userId: string, given: AssistantTokenSet | null): Promise<void> {
    const {repository, cipher} = this.deps;
    const name = instanceNameFor(userId, this.options.runtimeNamespace);
    const apiServerKey = randomBytes(32).toString('base64url');
    const claimed = await repository.claimProvisioning({
      userId, instanceName: name, zone: this.options.zone, bundleVersion: this.options.bundle.version, now: this.now(),
      apiServerKeyEnc: cipher.seal('assistants.api_server_key_enc', userId, apiServerKey),
    });
    if (!claimed) return;
    this.logger.log(`provisioning claimed instance=${name}`);

    const tokens = given ?? await this.refreshStored(userId);
    if (!tokens) {
      await repository.markFailed(userId, this.now());
      this.logger.warn(`provisioning failed instance=${name} cause=refresh_failed`);
      return;
    }
    // Generación del asistente: un borrado + activación nueva no repite requestId (OCB-012).
    const current = await repository.findActive(userId);
    const generation = current?.activation_started_at?.getTime();
    const hermes = initialHermesMetadata({
      apiServerKey,
      // Zona guardada al activar (OCB-016); sin ella, America/Bogota.
      timezone: current?.timezone ?? null,
      bundle: this.options.bundle,
      mcp: this.options.mcp,
      brainImage: this.options.brainImage,
      mcpTokens: hermesMcpTokens(tokens, this.options.issuer, this.now().getTime()),
    });
    const restoreUrl = await this.restoreUrl(userId, name);
    if (this.options.managedMetaExtensions) hermes['hermes-extensions'] = this.options.managedMetaExtensions;
    if (restoreUrl) hermes['hermes-restore-url'] = restoreUrl;

    for (let tries = 1; tries <= MAX_ATTEMPTS; tries++) {
      const attempt = await repository.recordAttempt(userId, this.now());
      const outcome = await this.attempt(name, hermes, insertRequestId(userId, attempt, generation, this.options.runtimeNamespace));
      if (outcome.ok) {
        await repository.appendEvent({userId, kind: 'vm.create_requested', phase: 'insert', detail: `attempt=${attempt} result=${outcome.result}`});
        this.logger.log(`vm insert ok instance=${name} attempt=${attempt} result=${outcome.result}`);
        return;
      }
      await repository.appendEvent({
        userId, kind: 'vm.create_failed', phase: outcome.phase, cause: 'vm_create_failed', detail: `attempt=${attempt} ${outcome.detail}`,
      });
      this.logger.warn(`vm insert failed instance=${name} attempt=${attempt} phase=${outcome.phase} ${outcome.detail}`);
      if (tries < MAX_ATTEMPTS) await this.sleep(this.options.retryDelayMs);
    }
    await repository.markFailed(userId, this.now());
    await repository.appendEvent({userId, kind: 'activation.failed', phase: 'create_vm', cause: 'vm_create_failed', detail: `attempts=${MAX_ATTEMPTS}`});
    this.logger.warn(`activation failed instance=${name} cause=vm_create_failed`);
  }

  /** Un fallo al buscar o firmar el archivo nunca frena la activación: la VM nace sin memorias anteriores. */
  private async restoreUrl(userId: string, name: string): Promise<string | null> {
    const source = this.deps.restoreUrl;
    if (!source) return null;
    try {
      const url = await source(userId, this.now());
      await this.deps.repository.appendEvent({userId, kind: url ? 'restore.offered' : 'restore.none', phase: 'insert'});
      if (url) this.logger.log(`restore offered instance=${name}`);
      return url;
    } catch (error) {
      const reason = error instanceof ArchiveError ? error.reason : 'other';
      await this.deps.repository.appendEvent({userId, kind: 'restore.lookup_failed', phase: 'insert', detail: `reason=${reason}`});
      this.logger.warn(`restore lookup failed instance=${name} reason=${reason}`);
      return null;
    }
  }

  /** Reanudación: antes de existir la VM, el servicio es el único dueño del refresh (revokeRefreshToken=false en dev). */
  private async refreshStored(userId: string): Promise<AssistantTokenSet | null> {
    const {repository, cipher, tokens} = this.deps;
    try {
      const sealed = await repository.readRefreshToken(userId);
      if (!sealed) throw new OAuthTokenError('rejected', 'missing_credential');
      const fresh = await tokens.refresh(cipher.open('assistant_credentials.refresh_token_enc', userId, sealed));
      const now = this.now();
      await repository.updateCredential(userId,
        cipher.seal('assistant_credentials.refresh_token_enc', userId, fresh.refreshToken),
        new Date(now.getTime() + fresh.expiresIn * 1000), now);
      return fresh;
    } catch (error) {
      const reason = error instanceof OAuthTokenError ? `${error.kind}:${error.reason}` : 'other';
      await repository.appendEvent({userId, kind: 'activation.failed', phase: 'refresh', cause: 'refresh_failed', detail: `reason=${reason}`});
      return null;
    }
  }

  private async attempt(name: string, hermes: HermesMetadata, requestId: string): Promise<AttemptOutcome> {
    const {compute} = this.deps;
    let phase = 'template';
    try {
      const items = mergeMetadata(await compute.templateMetadata(), hermes);
      phase = 'insert';
      const inserted = await compute.insertInstance({name, items, requestId});
      if (inserted.kind === 'exists') return {ok: true, result: 'exists'};
      phase = 'operation';
      return await this.followOperation(inserted.operation);
    } catch (error) {
      if (error instanceof ComputeError) return {ok: false, phase, detail: `status=${error.status} reason=${error.reason}`};
      if (error instanceof MetadataMergeError) return {ok: false, phase, detail: `reason=${error.reason}`};
      return {ok: false, phase, detail: 'reason=other'};
    }
  }

  private async followOperation(operation: string): Promise<AttemptOutcome> {
    const deadline = this.now().getTime() + this.options.operationTimeoutMs;
    const interval = this.options.pollIntervalMs ?? 2000;
    for (;;) {
      const status = await this.deps.compute.operationStatus(operation);
      if (status.done) {
        if (!status.errorReason) return {ok: true, result: 'created'};
        if (status.errorReason === 'RESOURCE_ALREADY_EXISTS') return {ok: true, result: 'exists'};
        return {ok: false, phase: 'operation', detail: `reason=${status.errorReason}`};
      }
      // Sin respuesta definitiva a tiempo: la VM sigue creándose; OCB-008 observa el resto.
      if (this.now().getTime() >= deadline) return {ok: true, result: 'pending'};
      await this.sleep(interval);
    }
  }
}
