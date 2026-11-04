import {Logger} from '@nestjs/common';

/**
 * Sondeo liviano de la foto del cerebro (AAB-013, D27): por lotes, a los usuarios con asistente listo, pide
 * `brainSnapshots.sync` (lee el sha que publica el watcher y solo descarga si cambió) y después reintenta el empuje
 * a BI de las versiones pendientes. La readiness y el barrido diario siguen igual. Mismo patrón que `SeedScheduler`.
 */
export class BrainSnapshotPoller {
  private readonly logger = new Logger('orqa-snapshot-poller');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      users: {readyUsers(limit: number): Promise<string[]>};
      sync: (userId: string) => Promise<unknown>;
      pushPending: (userId: string) => Promise<unknown>;
    },
    private readonly options: {intervalMs: number; batchSize: number},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {void this.tick();}, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  tick(): Promise<void> {
    if (!this.running) {
      this.running = (async () => {
        const users = await this.deps.users.readyUsers(this.options.batchSize);
        for (const userId of users) {
          await this.deps.sync(userId).catch(() => undefined);
          await this.deps.pushPending(userId).catch(() => undefined);
        }
      })().catch(() => this.logger.warn('orqa snapshot poll aborted')).finally(() => {this.running = null;});
    }
    return this.running;
  }
}
