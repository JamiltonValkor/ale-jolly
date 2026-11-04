import {Logger} from '@nestjs/common';
import {STOCK_LIMITS} from './config';
import type {Negotiation} from './negotiation';
import type {StockQuery} from './store';

export interface MaintenanceDeps {db: StockQuery; negotiation: Pick<Negotiation, 'sweep'>; now: () => Date}

/**
 * Tarea de operación, una por pod. Vencer y borrar son idempotentes, así que dos pods no se estorban. Lo que manda la
 * retención es `now()` de la base: un salto del reloj de banco no borra nada antes de tiempo.
 */
export class StockMaintenance {
  private readonly logger = new Logger('StockMaintenance');
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private lastRetention: number | undefined;

  constructor(private readonly deps: MaintenanceDeps) {}

  /** Una frase usada en una confirmación es evidencia (R3): sale solo la que nadie cita. Devuelve las borradas. */
  async retain(): Promise<number> {
    const {rowCount} = await this.deps.db.query(
      `DELETE FROM assistant.stock_owner_utterances u
        WHERE u.recorded_at < now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM assistant.stock_confirmations c WHERE c.utterance_id = u.id)`, [STOCK_LIMITS.utteranceRetentionDays]);
    return rowCount ?? 0;
  }

  private async pass(): Promise<void> {
    await this.deps.negotiation.sweep(); // También sin canal: el poller de `Negotiation` solo corre con adaptador.
    const at = this.deps.now().getTime();
    if (this.lastRetention !== undefined && at - this.lastRetention < STOCK_LIMITS.retentionIntervalMs) return;
    await this.retain();
    this.lastRetention = at;
  }

  /** Una pasada a la vez: la siguiente espera a la que está en curso. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {this.running = undefined;});
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => this.logger.warn(`mantenimiento: ${(error as Error).name}`)), STOCK_LIMITS.maintenanceIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
