import {Logger} from '@nestjs/common';
import type {CredentialRenewal} from './credential-renewal';
import type {CredentialStore} from './credential-store';

export interface RenewalSchedulerOptions {
  /** Cada cuánto corre el barrido. */
  sweepIntervalMs: number;
  /** Edad de la credencial guardada a partir de la cual se renueva (~7 días). */
  maxAgeMs: number;
  /** Máximo de asistentes por barrido. */
  batchSize: number;
  /** Retardo del primer barrido tras arrancar el pod. */
  initialDelayMs?: number;
}

export interface SweepSummary { due: number; renewed: number; failed: number; skipped: number }

/**
 * Barrido periódico en proceso (OCB-009): renueva la credencial de cada
 * asistente con VM (encendida o apagada) cuya credencial guardada tiene más de
 * `maxAgeMs`. Así la sesión offline (idle 30 días) se mantiene viva aunque la
 * VM esté apagada meses o Hermes no use el MCP, y el archivo de tokens de la
 * VM nunca tiene más de ~7 días. Sin leases: si dos pods coinciden, los dos
 * refrescos valen (revokeRefreshToken=false) y gana la última escritura.
 */
export class RenewalScheduler {
  private readonly logger = new Logger('credential-renewal');
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<SweepSummary> | null = null;

  constructor(
    private readonly renewal: CredentialRenewal,
    private readonly store: CredentialStore,
    private readonly options: RenewalSchedulerOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {void this.sweep().catch(() => this.logger.warn('credential sweep aborted'));};
    this.first = setTimeout(tick, this.options.initialDelayMs ?? Math.min(60_000, this.options.sweepIntervalMs));
    this.first.unref();
    this.timer = setInterval(tick, this.options.sweepIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Un barrido. Si ya hay uno en curso, devuelve ese. */
  sweep(): Promise<SweepSummary> {
    if (!this.running) this.running = this.run().finally(() => {this.running = null;});
    return this.running;
  }

  private async run(): Promise<SweepSummary> {
    const cutoff = new Date(this.now().getTime() - this.options.maxAgeMs);
    const users = await this.store.dueForRenewal(cutoff, this.options.batchSize);
    const summary: SweepSummary = {due: users.length, renewed: 0, failed: 0, skipped: 0};
    for (const userId of users) {
      try {
        const outcome = await this.renewal.renew(userId, 'sweep');
        if (outcome.result === 'renewed') summary.renewed++;
        else if (outcome.result === 'skipped') summary.skipped++;
        else summary.failed++;
      } catch {
        summary.failed++;
      }
    }
    if (users.length) {
      this.logger.log(`credential sweep due=${summary.due} renewed=${summary.renewed} failed=${summary.failed} skipped=${summary.skipped}`);
    }
    return summary;
  }
}
