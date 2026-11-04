import {createHash} from 'node:crypto';
import {Logger} from '@nestjs/common';
import {ComputeError} from '../compute/compute-client';
import type {InstanceApi} from '../compute/instance-client';
import {withMetadataValues} from '../compute/metadata';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {Database} from '../persistence/database';
import type {McpToolClient} from './mcp-client';

/**
 * Semilla del cerebro del negocio (ORQA OSB-007). Por cada negocio del dueño
 * (los que devuelve `saleads_get_account_overview` con SU token: un negocio
 * ajeno nunca aparece) pide `saleads_get_business_bootstrap`, arma
 * `seed.json` (`saleads-seed/1`), lo sube a GCS por contenido y fija
 * `hermes-seed-url` (GET firmado, ≤ 1 h) en la VM. El watcher la baja y corre
 * `saleads-brain ingest-seed` (sin IA) y publica `hermes/seed-status`.
 *
 * Nada de la semilla, la URL ni el token va a logs o eventos: solo ids de
 * negocio, conteos y códigos.
 */

export const SEED_SCHEMA = 'saleads-seed/1';
export const SEED_CONTENT_TYPE = 'application/json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SeedStorage {
  /** Sube el objeto (idempotente por nombre: el nombre lleva el hash del contenido). */
  upload(object: string, body: Buffer): Promise<void>;
  signedGetUrl(object: string, now: Date, ttlSeconds: number): Promise<string>;
}

export interface SeedOptions {
  ttlSeconds: number;
  toolTimeoutMs: number;
  /** Una VM que ya intentó en este plazo no se vuelve a intentar desde la readiness. */
  debounceMs: number;
}

export interface SeedDeps {
  repository: Pick<AssistantRepository, 'findActive' | 'appendEvent'>;
  instances: InstanceApi;
  accessToken: (userId: string) => Promise<string | null>;
  mcp: McpToolClient;
  storage: SeedStorage;
  now?: () => Date;
}

export type SeedResult =
  | {result: 'applied' | 'up_to_date'; businesses: number; failed: number}
  | {result: 'skipped'; reason: string};

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Objeto de la semilla: `seeds/<user>/<sha16>.json` (contenido sin `generated_at`). */
export function seedObjectName(userId: string, businesses: readonly unknown[]): string {
  return `seeds/${userId}/${sha256(JSON.stringify(businesses)).slice(0, 16)}.json`;
}

/** Ruta del objeto en una URL firmada (`https://storage.googleapis.com/<bucket>/<objeto>?…`), sin el bucket. */
const objectOfUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const path = decodeURIComponent(new URL(url).pathname).split('/').slice(2).join('/');
    return path || null;
  } catch {
    return null;
  }
};

/** Ids de los negocios del dueño según el MCP con su token (un negocio ajeno nunca aparece). */
export async function ownedBusinessIds(mcp: McpToolClient, token: string, timeoutMs: number): Promise<string[] | {error: string}> {
  const overview = await mcp.call(token, 'saleads_get_account_overview', {}, timeoutMs);
  if (!overview.ok) return {error: overview.code};
  const ids = (Array.isArray(overview.data.businesses) ? overview.data.businesses : [])
    .map(item => (item as {business_id?: unknown} | null)?.business_id)
    .filter((id): id is string => typeof id === 'string' && UUID.test(id));
  return [...new Set(ids)];
}

/** Negocio seleccionado en la web según el MCP con el token del dueño (null si no hay uno válido). */
export async function selectedBusinessId(mcp: McpToolClient, token: string, timeoutMs: number): Promise<string | null> {
  const overview = await mcp.call(token, 'saleads_get_account_overview', {}, timeoutMs);
  const id = overview.ok ? overview.data.selected_business_id : null;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

export class SeedService {
  private readonly logger = new Logger('orqa-seed');
  private readonly running = new Map<string, Promise<SeedResult>>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly options: SeedOptions, private readonly deps: SeedDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Desde la readiness: con debounce por usuario, sin esperar. */
  onReady(userId: string): Promise<SeedResult | null> {
    const last = this.lastAttempt.get(userId);
    if (last !== undefined && this.now().getTime() - last < this.options.debounceMs) return Promise.resolve(null);
    return this.refresh(userId);
  }

  /** Una semilla por usuario a la vez; las llamadas concurrentes comparten el intento. */
  refresh(userId: string): Promise<SeedResult> {
    const inFlight = this.running.get(userId);
    if (inFlight) return inFlight;
    this.lastAttempt.set(userId, this.now().getTime());
    const run = this.build(userId)
      .catch(async error => {
        const reason = error instanceof SeedFailed ? error.reason : 'unexpected';
        this.logger.warn(`orqa seed failed reason=${reason}`);
        await this.deps.repository.appendEvent({userId, kind: 'orqa.seed_failed', phase: 'orqa', cause: 'unknown', detail: `reason=${reason}`})
          .catch(() => undefined);
        return {result: 'skipped', reason} as SeedResult;
      })
      .finally(() => this.running.delete(userId));
    this.running.set(userId, run);
    return run;
  }

  private async build(userId: string): Promise<SeedResult> {
    const row = await this.deps.repository.findActive(userId);
    if (!row?.instance_name || row.status !== 'ready') return {result: 'skipped', reason: 'not_ready'};
    const token = await this.deps.accessToken(userId);
    if (!token) throw new SeedFailed('no_credential');

    const ids = await ownedBusinessIds(this.deps.mcp, token, this.options.toolTimeoutMs);
    if (!Array.isArray(ids)) throw new SeedFailed(`overview code=${ids.error}`);
    if (!ids.length) return {result: 'skipped', reason: 'no_businesses'};

    const businesses: Array<Record<string, unknown>> = [];
    let failed = 0;
    for (const businessId of ids) {
      const outcome = await this.deps.mcp.call(token, 'saleads_get_business_bootstrap', {business_id: businessId}, this.options.toolTimeoutMs);
      // Solo se acepta el paquete del negocio pedido.
      if (outcome.ok && outcome.data.business_id === businessId) {
        businesses.push(outcome.data);
        continue;
      }
      failed++;
      const code = outcome.ok ? 'business_mismatch' : outcome.code;
      await this.deps.repository.appendEvent({
        userId, kind: 'orqa.seed_business_failed', phase: 'orqa', cause: 'unknown', detail: `business=${businessId} code=${code}`,
      });
    }
    if (!businesses.length) throw new SeedFailed(`all_businesses_failed count=${failed}`);

    const object = seedObjectName(userId, businesses);
    const result = await this.publish(row.instance_name, object, businesses);
    await this.deps.repository.appendEvent({
      userId, kind: 'orqa.seed_published', phase: 'orqa', detail: `result=${result} businesses=${businesses.length} failed=${failed}`,
    });
    this.logger.log(`orqa seed instance=${row.instance_name} result=${result} businesses=${businesses.length} failed=${failed}`);
    return {result, businesses: businesses.length, failed};
  }

  /**
   * Sin cambios de contenido y con la semilla vigente ya cargada en la VM
   * (`hermes/seed-status` = `loaded:<sha256(url)[:12]>`, como el watcher), no
   * hace nada. Si no, sube (si hace falta) y firma una URL nueva.
   */
  private async publish(instance: string, object: string, businesses: Array<Record<string, unknown>>): Promise<'applied' | 'up_to_date'> {
    const view = await this.deps.instances.getInstance(instance);
    if (!view) throw new SeedFailed('instance_missing');
    const currentUrl = view.items.find(item => item.key === 'hermes-seed-url')?.value;
    if (objectOfUrl(currentUrl) === object) {
      const status = await this.deps.instances.guestAttribute(instance, 'hermes/seed-status').catch(() => null);
      if (status === `loaded:${sha256(currentUrl!).slice(0, 12)}`) return 'up_to_date';
    }
    const body = Buffer.from(`${JSON.stringify({schema: SEED_SCHEMA, generated_at: this.now().toISOString(), businesses})}\n`, 'utf8');
    try {
      await this.deps.storage.upload(object, body);
    } catch {
      throw new SeedFailed('upload_failed');
    }
    const url = await this.deps.storage.signedGetUrl(object, this.now(), this.options.ttlSeconds).catch(() => {throw new SeedFailed('sign_failed');});
    for (let attempt = 1; ; attempt++) {
      const current = attempt === 1 ? view : await this.deps.instances.getInstance(instance);
      if (!current) throw new SeedFailed('instance_missing');
      try {
        await this.deps.instances.setMetadata(instance, current.fingerprint, withMetadataValues(current.items, {'hermes-seed-url': url}));
        return 'applied';
      } catch (error) {
        if (error instanceof ComputeError && error.status === 412 && attempt === 1) continue;
        throw new SeedFailed(error instanceof ComputeError ? `set_metadata status=${error.status}` : 'set_metadata');
      }
    }
  }
}

class SeedFailed extends Error {
  constructor(readonly reason: string) {super(reason);}
}

/** Usuarios con el asistente listo, para el barrido diario. */
export class SeedSweepStore {
  constructor(private readonly database: Database) {}

  async readyUsers(limit: number): Promise<string[]> {
    const result = await this.database.pool.query(
      "SELECT user_id FROM assistant.assistants WHERE status = 'ready' AND deleted_at IS NULL AND instance_name IS NOT NULL ORDER BY user_id LIMIT $1",
      [limit]);
    return result.rows.map(row => String((row as {user_id: unknown}).user_id));
  }
}

/**
 * Barrido diario de ORQA: negocios nuevos o datos que cambiaron llegan a la VM
 * (una URL vencida sin cargar se vuelve a firmar) y, con `others`, otras tareas
 * por usuario (p. ej. rotar la URL de las fotos del cerebro, OSB-010).
 */
export class SeedScheduler {
  private readonly logger = new Logger('orqa-seed');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly seed: SeedService,
    private readonly store: SeedSweepStore,
    private readonly options: {intervalMs: number; batchSize: number},
    private readonly others: ReadonlyArray<(userId: string) => Promise<unknown>> = [],
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {void this.sweep();}, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  sweep(): Promise<void> {
    if (!this.running) {
      this.running = (async () => {
        const users = await this.store.readyUsers(this.options.batchSize);
        let applied = 0;
        for (const userId of users) {
          if ((await this.seed.refresh(userId)).result === 'applied') applied++;
          for (const task of this.others) await task(userId).catch(() => undefined);
        }
        this.logger.log(`orqa seed sweep users=${users.length} applied=${applied}`);
      })().catch(() => this.logger.warn('orqa seed sweep aborted')).finally(() => {this.running = null;});
    }
    return this.running;
  }
}
