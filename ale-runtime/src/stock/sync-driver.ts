import type {AssistantRepository} from '../persistence/assistant-repository';
import type {ManagedMetaBootstrap} from '../ai/managed-meta';
import {STOCK_LIMITS} from './config';

export interface StockSyncDeps {
  userIds: ReadonlySet<string>;
  repository: Pick<AssistantRepository, 'findActive' | 'appendEvent'>;
  /** El `onReady` envuelto de `main.ts`. `orqa.onReady` directo dejaría `done` marcado y perdería `afterSync`. */
  onReady(userId: string, instanceName: string | null, readySince: Date | null): Promise<void> | undefined;
  /**
   * Lo que `GET /me` hace antes de `onReady`. Sin esto, tras reiniciar el pod nadie verifica Meta, `canSynchronize`
   * da falso y `OrqaSync` salta en silencio: el driver pedía la sync y la VM seguía en la base (dev, 2-nov).
   */
  prepare?: (userId: string) => Promise<void>;
  now: () => Date;
}

/** Verifica la inferencia gestionada como lo haría abrir la web, sin otra escritura que la de esa misma verificación. */
export function managedMetaPrepare(meta: Pick<ManagedMetaBootstrap, 'manages' | 'isVerified' | 'request' | 'idle'>) {
  return async (userId: string): Promise<void> => {
    if (!meta.manages(userId) || meta.isVerified(userId)) return;
    meta.request(userId);
    await meta.idle();
  };
}
export interface StockSyncTick {requested: number; notReady: number; failed: number}
type Outcome = keyof StockSyncTick;

/**
 * Hoy solo `GET /assistants/me` dispara `onReady` y el barrido global está apagado. Esto lleva Stock a la VM sin abrir
 * la web, acotado a `STOCK_USER_IDS` y en serie. Clave, candado y plazo tras falla son los de `OrqaSync`.
 */
export class StockSyncDriver {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private stopped = false;
  private readonly kicked = new Map<string, number>();

  constructor(private readonly options: {intervalMs: number}, private readonly deps: StockSyncDeps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {void this.tick().catch(() => undefined);}, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
  }

  /** Una corrida a la vez: si la anterior sigue, esta no se acumula. */
  async tick(): Promise<StockSyncTick> {
    const total: StockSyncTick = {requested: 0, notReady: 0, failed: 0};
    if (this.ticking || this.stopped) return total;
    this.ticking = true;
    return this.enqueue(async () => {
      try {
        for (const userId of this.deps.userIds) total[await this.request(userId)]++;
      } finally {this.ticking = false;}
      return total;
    });
  }

  kick(userId: string): void {
    if (this.stopped || !this.deps.userIds.has(userId)) return;
    const at = this.deps.now().getTime();
    const last = this.kicked.get(userId);
    if (last !== undefined && at - last < STOCK_LIMITS.syncKickDebounceSeconds * 1000) return;
    this.kicked.set(userId, at);
    void this.enqueue(() => this.request(userId));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(userId: string): Promise<Outcome> {
    try {
      const row = await this.deps.repository.findActive(userId);
      if (row?.status !== 'ready' || !row.instance_name) return 'notReady';
      // Se registra antes: si `canSynchronize` da falso, `OrqaSync` no deja rastro.
      await this.deps.repository.appendEvent({userId, kind: 'stock.sync_requested', phase: 'orqa'}).catch(() => undefined);
      await this.deps.prepare?.(userId);
      await this.deps.onReady(userId, row.instance_name, row.ready_since);
      return 'requested';
    } catch {
      return 'failed';
    }
  }
}
