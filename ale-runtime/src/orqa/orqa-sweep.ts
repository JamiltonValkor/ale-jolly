import {Logger} from '@nestjs/common';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {OrqaSync} from './orqa-sync';

export interface OrqaSweepOptions {
  /** `ORQA_SYNC_SWEEP_ENABLED`: apagado, `start()` no hace nada (solo sincronizan GET /me y `resync`). */
  enabled: boolean;
  /** Primer barrido tras el arranque del pod. */
  delayMs: number;
  intervalMs: number;
  /** Pausa entre una VM y la siguiente (sin apuro: la sync puede reiniciar Hermes unos segundos). */
  pauseMs: number;
  /** Las VMs del laboratorio (`sa-assistant-sim-*`) son de la sesión Orqa etapa 2: fuera salvo que se pida. */
  includeLab: boolean;
}

export interface OrqaSweepDeps {
  orqa: Pick<OrqaSync, 'enabled' | 'onReady'>;
  repository: Pick<AssistantRepository, 'listReady' | 'appendEvent'>;
  sleep?: (ms: number) => Promise<void>;
}

export interface OrqaSweepSummary { count: number; synced: number; skipped: number; failed: number }

/** Prefijo de las instancias del simulador del laboratorio (invariante 10 de la ola). */
export const LAB_INSTANCE_PREFIX = 'sa-assistant-sim-';
/** Los eventos del barrido no son de un dueño: van con este `user_id` técnico. */
export const SWEEP_EVENT_USER = 'system';

/**
 * MCB-020 (D21, D25): cada versión nueva del bundle llega a todos los asistentes listos, también a los de dueños que
 * nunca abren la web (solo Telegram o WhatsApp). Al arrancar el pod y cada `intervalMs`, recorre en serie los
 * asistentes `ready` y llama a la MISMA sincronización que dispara GET /me: misma clave de «hecho», mismo plazo tras
 * un fallo y mismo candado por usuario (espera a un PUT /ai o /timezone en curso). Una VM ya sincronizada no hace
 * nada. No cambia qué se actualiza, solo cuándo. Sin prompts, chats ni IPs en eventos ni logs.
 *
 * Corre en una sola réplica (`replicas: 1`); con más, haría falta un candado compartido.
 */
export class OrqaSweep {
  private readonly logger = new Logger('orqa-sweep');
  private readonly sleep: (ms: number) => Promise<void>;
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<OrqaSweepSummary> | null = null;
  private stopped = false;

  constructor(private readonly options: OrqaSweepOptions, private readonly deps: OrqaSweepDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
  }

  start(): void {
    if (!this.options.enabled || !this.deps.orqa.enabled || this.timer) return;
    this.stopped = false;
    const tick = () => {void this.sweep().catch(() => this.logger.warn('orqa sweep aborted'));};
    this.first = setTimeout(tick, this.options.delayMs);
    this.first.unref();
    this.timer = setInterval(tick, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Un barrido. Si ya hay uno en curso, devuelve ese (nunca dos a la vez). */
  sweep(): Promise<OrqaSweepSummary> {
    if (!this.running) this.running = this.run().finally(() => {this.running = null;});
    return this.running;
  }

  private async run(): Promise<OrqaSweepSummary> {
    const all = await this.deps.repository.listReady();
    const ready = this.options.includeLab ? all : all.filter(row => !row.instance_name.startsWith(LAB_INSTANCE_PREFIX));
    const summary: OrqaSweepSummary = {count: ready.length, synced: 0, skipped: 0, failed: 0};
    await this.event('orqa.sweep_started', `count=${summary.count}`);
    for (const [index, row] of ready.entries()) {
      if (this.stopped) break;
      if (index > 0) await this.sleep(this.options.pauseMs);
      if (this.stopped) break;
      // onReady nunca rechaza: un fallo de una VM queda en su orqa.sync_failed y el barrido sigue con la siguiente.
      const result = await this.deps.orqa.onReady(row.user_id, row.instance_name, row.ready_since).catch(() => 'failed' as const);
      summary[result]++;
    }
    await this.event('orqa.sweep_done', `synced=${summary.synced} skipped=${summary.skipped} failed=${summary.failed}`);
    this.logger.log(`orqa sweep done count=${summary.count} synced=${summary.synced} skipped=${summary.skipped} failed=${summary.failed}`);
    return summary;
  }

  private async event(kind: string, detail: string): Promise<void> {
    await this.deps.repository.appendEvent({userId: SWEEP_EVENT_USER, kind, phase: 'orqa', detail}).catch(() => undefined);
  }
}
