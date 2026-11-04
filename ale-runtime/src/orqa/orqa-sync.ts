import {Logger} from '@nestjs/common';
import {jobTextHash, type AgentBundle, type BundleJob} from '../activation/hermes-files';
import {hermesProfiles, type ProfileOptions} from '../activation/profiles';
import {metaRuntimeExtensions} from '../activation/vm-extensions';
import {isManagedMetaUser, type ManagedMetaScope} from '../ai/meta-model';
import type {BusinessTypeV1} from '../contracts/v1';
import type {HermesConfigWriter} from '../assistant-config/hermes-config-writer';
import type {UserLocks} from '../assistant-config/user-locks';
import {ComputeError} from '../compute/compute-client';
import type {InstanceApi, InstanceView} from '../compute/instance-client';
import {computeAppliedVersion, withMetadataValues, type HermesMetadata} from '../compute/metadata';
import type {HermesApi, HermesJobsApi, HermesJobView, HermesTarget, JobTextPatch, JobUpdateOutcome} from '../hermes/hermes-client';
import {classifyHealth} from '../lifecycle/readiness';
import type {AssistantRepository, AssistantRow} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import type {SkillsWriter} from '../skills/skills-writer';

export interface OrqaSyncOptions {
  bundle: AgentBundle;
  /** Imagen privada del cerebro; vacío = ORQA apagado (no se sincroniza nada). */
  brainImage: string | null;
  ackTimeoutMs: number;
  /** Plazo para que Hermes vuelva sano tras un cambio de config.yaml (reinicio del contenedor). */
  restartTimeoutMs: number;
  healthTimeoutMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  /** Tras un fallo, la siguiente lectura de GET /me no reintenta antes de esto. */
  retryAfterMs: number;
  /**
   * MCB-003 (D21/D24, `ORQA_JOB_UPDATES_ENABLED`): actualiza el texto de los trabajos de SaleADS que ya existen y
   * no recrea los que el dueño borró. Apagado = solo crea por nombre los que faltan (comportamiento previo).
   */
  updateJobs?: boolean;
  /** MCB-012 (`SPECIALIST_EXPLICIT_READS_ENABLED`): cada especialista lee solo sus lecturas exactas de SaleADS. */
  explicitReads?: boolean;
  /**
   * MCB-010 (`RESEARCHER_NATIVE_SEARCH_ENABLED`): búsqueda nativa del investigador, solo para filas con
   * `ai_provider = 'openai-codex'` (con otro proveedor sería una tool que falla en cada turno).
   */
  researcherNativeSearch?: boolean;
  managedMeta?: ManagedMetaScope;
}

/** Resultado de una llamada a `onReady` (el barrido de MCB-020 los cuenta). */
export type OrqaSyncResult = 'synced' | 'skipped' | 'failed';

/** Reuse ORQA's in-flight/cache identity; attach Meta's seeding follow-up only once per successful sync. */
export function readySyncCallback(orqa: Pick<OrqaSync, 'enabled' | 'onReady'>,
  afterSync: (userId: string) => Promise<unknown>, managedMeta: boolean) {
  const handled = new WeakMap<Promise<OrqaSyncResult>, Promise<void>>();
  return (userId: string, instanceName: string | null, readySince: Date | null): Promise<void> | undefined => {
    if (!orqa.enabled) return;
    const sync = orqa.onReady(userId, instanceName, readySince);
    if (managedMeta && handled.has(sync)) return handled.get(sync);
    const task = sync.then(async result => {
      if (managedMeta && result !== 'synced') return;
      await afterSync(userId);
    }).catch(() => undefined);
    if (managedMeta) handled.set(sync, task);
    return task;
  };
}

interface JobsSummary { created: number; updated: number; updateFailed: number; skipped: number }

/** Variante por usuario sobre el bundle. Sin habilitar, no se toca nada: misma referencia y mismos bytes. */
export interface BundleAddon {
  readonly variant: string;
  readonly skills: Readonly<Record<string, string>>;
  readonly brainImage: string;
  enabledFor(userId: string): boolean;
  merge(bundle: AgentBundle): AgentBundle;
  extensions(base: string): string;
}

export interface OrqaSyncDeps {
  addon?: BundleAddon;
  /** Managed inference must be verified before a background sweep changes its profiles. */
  canSynchronize?: (userId: string) => boolean;
  repository: Pick<AssistantRepository, 'findActive' | 'appendEvent' | 'syncedBundleVersions'>;
  instances: InstanceApi;
  hermes: HermesApi & HermesJobsApi;
  cipher: FieldCipher;
  config: Pick<HermesConfigWriter, 'build'>;
  skills: Pick<SkillsWriter, 'compose'>;
  installedFiles: (userId: string) => Promise<ReadonlyArray<{item_id: string; files: Record<string, unknown>}>>;
  /** Tipos confirmados en los negocios del dueño (MLB-002): eligen las skills de `types/`. */
  businessTypes: (userId: string) => Promise<ReadonlyArray<BusinessTypeV1>>;
  locks: UserLocks;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const ACK_KEY = 'hermes/applied-version';
/** El watcher publica su versión; `hermes-profiles` solo va a uno que lo soporta (MLB-005b). */
const WATCHER_VERSION_KEY = 'hermes/watcher-version';
const PROFILES_WATCHER_VERSION = 3;
/** Canales del dueño con chat de inicio en Hermes; sin canal, la salida queda solo en la VM. */
const DELIVER = 'all';
/** Origen que Hermes guarda en un trabajo creado por su REST (`api_server.py` `_cron_origin_from_request`). */
const SALEADS_ORIGIN = {platform: 'api_server', chatId: 'api'};
const short = (hash: string) => hash.slice(0, 12);
/** Proveedor de la suscripción ChatGPT: el único con el `web_search` nativo del backend Codex (MCB-010). */
const OPENAI_CODEX = 'openai-codex';
const outcomeDetail = (outcome: JobUpdateOutcome) =>
  outcome.kind === 'rejected' ? `outcome=rejected status=${outcome.status}` : outcome.kind === 'unreachable' ? `outcome=unreachable reason=${outcome.reason}` : `outcome=${outcome.kind}`;

class SyncFailed extends Error {
  constructor(readonly reason: string) {super(reason);}
}

/**
 * ORQA cliente (OSB-009): al quedar lista la VM, en este orden:
 * 1. config → la metadata que SaleADS gestiona para ORQA (hermes-config con el
 *    MCP del cerebro, SOUL, bundle, skills con las instaladas del catálogo e
 *    imagen del cerebro) se fusiona si difiere;
 * 2. ack → `hermes/applied-version` igual al hash esperado;
 * 3. `/health` → Hermes sano (tras el reinicio si cambió config.yaml);
 * 4. jobs → crea por nombre los `saleads:*` del bundle que falten. Nunca borra
 *    ninguno. Con `updateJobs` (MCB-003, D21/D24), además:
 *    - solo toca un trabajo con nombre exacto del bundle Y origen REST de
 *      SaleADS (`api_server`/`api`), nunca los del dueño ni los de Ale;
 *    - solo si su texto (`prompt` + `skills`) es el de alguna versión del
 *      bundle: uno editado por el dueño o por Ale se respeta;
 *    - solo cambia `prompt` y `skills`: nunca `enabled` (la pausa del dueño
 *      sigue), `schedule`, `deliver`, `name` ni `repeat`;
 *    - no recrea un trabajo que esta VM ya tuvo (una sync anterior lo dejó) y
 *      el dueño borró;
 *    - un PATCH fallido queda como evento y no hace fallar la sincronización
 *      (ni se reintenta en la vida del pod: idempotente por hash).
 *
 * Una sincronización por usuario, bundle e instancia en la vida del pod (las
 * VMs que ya estaban listas reciben el bundle nuevo en su siguiente GET /me);
 * cambiar el tipo de un negocio la repite (`resync`). Corre en
 * segundo plano, en serie con PUT /ai, PUT /timezone y el start. Ningún valor
 * de metadata ni prompt va a los logs.
 */
export class OrqaSync {
  private readonly logger = new Logger('orqa');
  private readonly done = new Map<string, string>();
  private readonly failedAt = new Map<string, number>();
  private readonly running = new Map<string, Promise<OrqaSyncResult>>();
  private readonly revisions = new Map<string, number>();
  private readyHook: ((userId: string, instanceName: string | null, readySince: Date | null) => unknown) | null = null;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OrqaSyncOptions, private readonly deps: OrqaSyncDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
  }

  get enabled(): boolean {
    return !!this.options.brainImage;
  }

  /**
   * El `onReady` envuelto de `main.ts` (`readySyncCallback`): la semilla del cerebro y lo demás que va tras una
   * sincronización cuelgan de él. Sin esto, `resync` (cambio de tipo, reintento de 30 s) y el barrido sincronizaban
   * por fuera, dejaban `done` marcado y la readiness ya no volvía a disparar la semilla: cerebro vacío (E2E 4-nov).
   */
  useReadyCallback(hook: (userId: string, instanceName: string | null, readySince: Date | null) => unknown): void {
    this.readyHook = hook;
  }

  /** `onReady` pasando por el envoltorio: el gancho arranca la sincronización y aquí se recibe esa misma promesa. */
  syncNotifying(userId: string, instanceName: string | null, readySince: Date | null = null): Promise<OrqaSyncResult> {
    this.readyHook?.(userId, instanceName, readySince);
    return this.onReady(userId, instanceName, readySince);
  }

  /** Disparo sin espera desde la readiness. Devuelve la promesa para las pruebas. */
  onReady(userId: string, instanceName: string | null, readySince: Date | null = null): Promise<OrqaSyncResult> {
    if (!this.enabled || !instanceName) return Promise.resolve('skipped');
    if (this.deps.canSynchronize && !this.deps.canSynchronize(userId)) return Promise.resolve('skipped');
    // Borrar y reactivar recrea la VM con el MISMO nombre: sin `ready_since` en la clave, la VM nueva
    // se daba por sincronizada y no recibía equipo, skills ni jobs hasta reiniciar el pod (dev, 20-oct).
    const addon = this.addonFor(userId);
    // La variante protege `done` si habilitar deja de exigir reiniciar el pod.
    const key = `${this.options.bundle.version}|${instanceName}|${readySince?.toISOString() ?? ''}${addon ? `|${addon.variant}` : ''}`;
    if (this.done.get(userId) === key) return Promise.resolve('skipped');
    const failed = this.failedAt.get(userId);
    if (failed !== undefined && this.now().getTime() - failed < this.options.retryAfterMs) return Promise.resolve('skipped');
    const inFlight = this.running.get(userId);
    if (inFlight) return inFlight;
    const revision = this.revisions.get(userId) ?? 0;
    const run: Promise<OrqaSyncResult> = this.deps.locks.run(userId, () => this.sync(userId))
      .then(
        (): OrqaSyncResult => {
          if ((this.revisions.get(userId) ?? 0) === revision) {this.done.set(userId, key); this.failedAt.delete(userId);}
          return 'synced';
        },
        error => {
          if ((this.revisions.get(userId) ?? 0) === revision) this.failedAt.set(userId, this.now().getTime());
          const reason = error instanceof SyncFailed ? error.reason : 'unexpected';
          this.logger.warn(`orqa sync failed instance=${instanceName} reason=${reason}`);
          return this.deps.repository.appendEvent({userId, kind: 'orqa.sync_failed', phase: 'orqa', cause: 'unknown', detail: `reason=${reason}`})
            .catch(() => undefined).then((): OrqaSyncResult => 'failed');
        },
      )
      .finally(() => this.running.delete(userId));
    this.running.set(userId, run);
    return run;
  }

  /**
   * El dueño cambió el tipo de un negocio (MLB-002 → MLB-003): olvida la
   * sincronización hecha y vuelve a sincronizar ya, sin esperar al pod ni a la
   * pausa tras un fallo. Si hay una en curso, corre después de ella.
   */
  async resync(userId: string): Promise<void> {
    if (!this.enabled) return;
    // Invalidate before yielding: the old sync must not authorize a first-use run
    // while the newly persisted business type is waiting for its replacement.
    this.revisions.set(userId, (this.revisions.get(userId) ?? 0) + 1);
    this.done.delete(userId);
    this.failedAt.delete(userId);
    await this.running.get(userId);
    const row = await this.deps.repository.findActive(userId);
    if (row?.status === 'ready') await this.syncNotifying(userId, row.instance_name, row.ready_since);
  }

  /**
   * Read-only completion proof for the automatic first guide. Desired metadata
   * and the process cache are not proof that the watcher finished its initial
   * profiles/toolset restart. A late ACK may converge after sync timed out, so
   * verify it directly even during the background retry backoff.
   */
  async readyForFirstUse(row: AssistantRow): Promise<boolean> {
    if (!this.enabled || !row.instance_name || !row.api_server_key_enc) return false;
    if (this.deps.canSynchronize && !this.deps.canSynchronize(row.user_id)) return false;
    const revision = this.revisions.get(row.user_id) ?? 0;
    await this.running.get(row.user_id);
    const current = await this.deps.repository.findActive(row.user_id);
    if (!this.sameActivation(row, current)) return false;
    const view = await this.instance(row.instance_name);
    if (!view.generation || !view.privateIp) return false;
    const desired = await this.desired(current!);
    if (!desired['hermes-profiles']) return false;
    if (!Object.entries(desired).every(([key, value]) => view.items.find(item => item.key === key)?.value === value)) {
      void this.resync(row.user_id).catch(() => undefined);
      return false;
    }
    const expected = computeAppliedVersion(view.items);
    if (await this.deps.instances.guestAttribute(row.instance_name, ACK_KEY) !== expected) return false;
    const target = {ip: view.privateIp, apiServerKey: this.deps.cipher.open('assistants.api_server_key_enc', row.user_id, current!.api_server_key_enc!)};
    if (classifyHealth(await this.deps.hermes.health(target, this.options.healthTimeoutMs)) !== 'healthy') return false;
    const confirmed = await this.instance(row.instance_name);
    const latest = await this.deps.repository.findActive(row.user_id);
    if (!this.sameActivation(row, latest)) return false;
    const latestDesired = await this.desired(latest!);
    return confirmed.generation === view.generation && computeAppliedVersion(confirmed.items) === expected
      && Object.entries(latestDesired).every(([key, value]) => desired[key as keyof HermesMetadata] === value)
      && Object.keys(latestDesired).length === Object.keys(desired).length
      && (this.revisions.get(row.user_id) ?? 0) === revision && !this.running.has(row.user_id);
  }

  private sameActivation(expected: AssistantRow, current: AssistantRow | null): boolean {
    return !!current && current.status === 'ready' && current.ai_configured
      && current.user_id === expected.user_id && current.instance_name === expected.instance_name
      && current.created_at?.getTime() === expected.created_at?.getTime()
      && current.ready_since?.getTime() === expected.ready_since?.getTime()
      && !!current.api_server_key_enc && !!expected.api_server_key_enc && current.api_server_key_enc.equals(expected.api_server_key_enc);
  }

  private async sync(userId: string): Promise<void> {
    const row = await this.deps.repository.findActive(userId);
    if (!row || row.status !== 'ready' || !row.instance_name || !row.api_server_key_enc) throw new SyncFailed(`not_ready status=${row?.status ?? 'none'}`);
    const desired = await this.desired(row);
    const {view, written, configChanged} = await this.applyMetadata(row.instance_name, desired);
    if (!view.privateIp) throw new SyncFailed('no_private_ip');
    const target: HermesTarget = {ip: view.privateIp, apiServerKey: this.deps.cipher.open('assistants.api_server_key_enc', row.user_id, row.api_server_key_enc)};
    const deadline = this.now().getTime() + (configChanged ? this.options.restartTimeoutMs : this.options.healthTimeoutMs);
    const healthy = await this.until(deadline, async () =>
      classifyHealth(await this.deps.hermes.health(target, this.options.healthTimeoutMs)) === 'healthy');
    if (!healthy) throw new SyncFailed('health_timeout');
    const jobs = await this.ensureJobs(row, target);
    const updates = this.options.updateJobs ? ` jobs_updated=${jobs.updated} jobs_update_failed=${jobs.updateFailed}` : '';
    await this.deps.repository.appendEvent({
      userId, kind: 'orqa.synced', phase: 'orqa',
      detail: `bundle=${this.options.bundle.version} metadata_written=${written} jobs_created=${jobs.created}${updates}`,
    });
    this.logger.log(`orqa synced instance=${row.instance_name} jobs_created=${jobs.created}${updates}`);
  }

  private addonFor(userId: string): BundleAddon | undefined {
    return this.deps.addon?.enabledFor(userId) ? this.deps.addon : undefined;
  }

  /** La versión efectiva solo sale en `hermes-bundle-version`: eventos, `done` y trabajos siguen con la base. */
  private async desired(row: AssistantRow): Promise<HermesMetadata> {
    const {brainImage} = this.options;
    const addon = this.addonFor(row.user_id);
    const bundle = addon ? addon.merge(this.options.bundle) : this.options.bundle;
    const types = await this.deps.businessTypes(row.user_id);
    // Una VM con el watcher viejo no sabe aplicar hermes-profiles: nunca llegaría el ack (ack_timeout en bucle).
    const profiles = row.instance_name && await this.watcherSupportsProfiles(row.instance_name) ? hermesProfiles(bundle, types, this.profileOptions(row)) : null;
    const installed = await this.deps.installedFiles(row.user_id);
    return {
      'hermes-bundle-version': bundle.version,
      'hermes-config': this.deps.config.build(row),
      'hermes-skills': addon ? this.deps.skills.compose(installed, types, addon.skills) : this.deps.skills.compose(installed, types),
      'hermes-soul': bundle.soul,
      ...(brainImage ? {'hermes-brain-image': addon?.brainImage ?? brainImage} : {}),
      ...(profiles ? {'hermes-profiles': profiles} : {}),
      ...(isManagedMetaUser(this.options.managedMeta, row.user_id) ? {'hermes-extensions': addon ? addon.extensions(metaRuntimeExtensions()) : metaRuntimeExtensions()} : {}),
    };
  }

  /** Opciones de la capa de los especialistas para esta fila; apagadas, la capa de siempre (mismo valor, mismo ack). */
  private profileOptions(row: AssistantRow): ProfileOptions {
    return {
      ...(this.options.explicitReads ? {explicitReads: true} : {}),
      ...(this.options.researcherNativeSearch && row.ai_provider === OPENAI_CODEX ? {nativeSearch: true} : {}),
      ...(isManagedMetaUser(this.options.managedMeta, row.user_id) ? {metaSearch: true} : {}),
      ...(isManagedMetaUser(this.options.managedMeta,row.user_id)&&!!this.options.bundle.profiles.curador?{scopedMemory:true}:{}),
      ...(this.addonFor(row.user_id) ? {stock: true} : {}),
    };
  }

  private async watcherSupportsProfiles(name: string): Promise<boolean> {
    const version = await this.deps.instances.guestAttribute(name, WATCHER_VERSION_KEY).catch(() => null);
    return Number.parseInt(version ?? '', 10) >= PROFILES_WATCHER_VERSION;
  }

  /** Fusiona solo lo que difiere; incluso sin escritura, la metadata debe estar aplicada. */
  private async applyMetadata(name: string, desired: HermesMetadata): Promise<{view: InstanceView; written: boolean; configChanged: boolean}> {
    for (let attempt = 1; ; attempt++) {
      const view = await this.instance(name);
      const changed = Object.entries(desired).filter(([key, value]) => view.items.find(item => item.key === key)?.value !== value);
      if (!changed.length) {
        await this.waitAck(name, desired, computeAppliedVersion(view.items));
        return {view, written: false, configChanged: false};
      }
      const items = withMetadataValues(view.items, Object.fromEntries(changed) as HermesMetadata);
      try {
        await this.deps.instances.setMetadata(name, view.fingerprint, items);
      } catch (error) {
        if (error instanceof ComputeError && error.status === 412 && attempt === 1) continue;
        throw new SyncFailed(error instanceof ComputeError ? `set_metadata status=${error.status}` : 'set_metadata');
      }
      await this.waitAck(name, desired, computeAppliedVersion(items));
      // Solo un cambio de config.yaml reinicia el contenedor de Hermes (watcher v2).
      return {view, written: true, configChanged: changed.some(([key]) => key === 'hermes-config')};
    }
  }

  /** Si otra escritura (renovación, IA) cambió la metadata, recalcula sobre la vigente mientras siga llevando lo nuestro. */
  private async waitAck(name: string, desired: HermesMetadata, first: string): Promise<void> {
    let expected = first;
    let lastAck: string | null | undefined;
    const acked = await this.until(this.now().getTime() + this.options.ackTimeoutMs, async () => {
      const ack = await this.deps.instances.guestAttribute(name, ACK_KEY).catch(() => null);
      if (ack === expected) return true;
      if (ack === lastAck) return false;
      lastAck = ack;
      const current = await this.instance(name);
      const ours = Object.entries(desired).every(([key, value]) => current.items.find(item => item.key === key)?.value === value);
      if (!ours) throw new SyncFailed('metadata_overwritten');
      expected = computeAppliedVersion(current.items);
      return ack === expected;
    });
    if (!acked) throw new SyncFailed('ack_timeout');
  }

  private async ensureJobs(row: AssistantRow, target: HermesTarget): Promise<JobsSummary> {
    const summary: JobsSummary = {created: 0, updated: 0, updateFailed: 0, skipped: 0};
    // Continuous managed jobs require a selected, authenticated business/session
    // and are installed atomically paused by ManagedBusinessJobs instead.
    if(isManagedMetaUser(this.options.managedMeta,row.user_id)&&this.options.bundle.profiles.curador)return summary;
    const jobs = this.options.bundle.jobs;
    if (!jobs.length) return summary;
    const listed = await this.deps.hermes.listJobs(target, this.options.requestTimeoutMs);
    if (listed.kind !== 'ok') throw new SyncFailed(`jobs_list_${listed.kind === 'unreachable' ? listed.reason : listed.kind}`);
    const existing = new Set(listed.names);
    // D24: los trabajos que esta VM ya tuvo (una sync anterior los dejó todos) y hoy faltan los borró el dueño.
    const hadBefore = this.options.updateJobs ? await this.namesSyncedBefore(row) : new Set<string>();
    for (const job of jobs) {
      if (!existing.has(job.name)) {
        if (hadBefore.has(job.name)) {
          summary.skipped++;
          await this.jobEvent(row.user_id, 'orqa.job_update_skipped', `name=${job.name} reason=deleted`);
          continue;
        }
        const outcome = await this.deps.hermes.createJob(target, {...job, deliver: DELIVER}, this.options.requestTimeoutMs);
        if (outcome.kind !== 'created') {
          throw new SyncFailed(`job_create name=${job.name} ${outcome.kind === 'rejected' ? `status=${outcome.status}` : outcome.kind === 'unreachable' ? outcome.reason : outcome.kind}`);
        }
        summary.created++;
        continue;
      }
      if (!this.options.updateJobs) continue;
      await this.updateJob(row.user_id, target, job, listed.jobs.filter(live => live.name === job.name), summary);
    }
    return summary;
  }

  /** D21: un solo trabajo con el nombre, de origen SaleADS y con un texto conocido del bundle → PATCH de su texto. */
  private async updateJob(userId: string, target: HermesTarget, job: BundleJob, matches: HermesJobView[], summary: JobsSummary): Promise<void> {
    const ours = matches.filter(live => live.origin.platform === SALEADS_ORIGIN.platform && live.origin.chatId === SALEADS_ORIGIN.chatId);
    // Dos con el mismo nombre (aunque uno sea de SaleADS): no se adivina cuál es cuál, no se toca ninguno.
    if (matches.length !== 1 || ours.length !== 1) {
      summary.skipped++;
      await this.jobEvent(userId, 'orqa.job_update_skipped', `name=${job.name} reason=${matches.length > 1 ? 'duplicate_name' : 'not_saleads_origin'}`);
      return;
    }
    const live = ours[0]!;
    const desired = jobTextHash(job.prompt, job.skills);
    const current = jobTextHash(live.prompt, live.skills);
    if (desired === current) return;
    if (!(this.options.bundle.knownJobHashes[job.name] ?? []).includes(current)) {
      summary.skipped++;
      await this.jobEvent(userId, 'orqa.job_update_skipped', `name=${job.name} reason=edited from=${short(current)}`);
      return;
    }
    const patch: JobTextPatch = {};
    if (live.prompt !== job.prompt) patch.prompt = job.prompt;
    if (JSON.stringify(live.skills) !== JSON.stringify(job.skills)) patch.skills = [...job.skills];
    const outcome = await this.deps.hermes.updateJob(target, live.id, patch, this.options.requestTimeoutMs);
    if (outcome.kind !== 'updated') {
      summary.updateFailed++;
      this.logger.warn(`orqa job update failed name=${job.name} ${outcomeDetail(outcome)}`);
      await this.jobEvent(userId, 'orqa.job_update_failed', `name=${job.name} ${outcomeDetail(outcome)}`);
      return;
    }
    summary.updated++;
    await this.jobEvent(userId, 'orqa.job_updated', `name=${job.name} fields=${Object.keys(patch).join(',')} from=${short(current)} to=${short(desired)}`);
  }

  /** Nombres de los trabajos de las versiones del bundle con que esta VM ya quedó sincronizada. */
  private async namesSyncedBefore(row: AssistantRow): Promise<Set<string>> {
    const versions = await this.deps.repository.syncedBundleVersions(row.user_id, row.created_at);
    return new Set(versions.flatMap(version => this.options.bundle.jobNamesByVersion[version] ?? []));
  }

  /** Eventos de trabajos: nombre, motivo y hashes cortos; nunca el prompt. Un fallo al registrar no rompe la sync. */
  private async jobEvent(userId: string, kind: string, detail: string): Promise<void> {
    await this.deps.repository.appendEvent({userId, kind, phase: 'orqa', detail}).catch(() => undefined);
  }

  private async instance(name: string): Promise<InstanceView> {
    let view: InstanceView | null;
    try {
      view = await this.deps.instances.getInstance(name);
    } catch (error) {
      throw new SyncFailed(error instanceof ComputeError ? `get status=${error.status}` : 'get');
    }
    if (!view) throw new SyncFailed('instance_missing');
    if (view.status !== 'RUNNING') throw new SyncFailed(`instance_${view.status.toLowerCase()}`);
    return view;
  }

  private async until(deadline: number, check: () => Promise<boolean>): Promise<boolean> {
    for (;;) {
      if (await check()) return true;
      const left = deadline - this.now().getTime();
      if (left <= 0) return false;
      await this.sleep(Math.min(this.options.pollIntervalMs, left));
    }
  }
}
