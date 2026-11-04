import {Logger} from '@nestjs/common';
import type {InstanceApi} from '../compute/instance-client';
import type {AssistantStateV1} from '../contracts/v1';
import type {HermesApi} from '../hermes/hermes-client';
import type {AssistantRepository, AssistantRow} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import {toAssistantState, type AssistantStateReader} from '../state/assistant-state';
import {classifyHealth, needsObservation, nextTransition, vmPhase, type VmObservation} from './readiness';
import type {ReadinessRepository} from './readiness-repository';

export interface ReadinessOptions {
  healthTimeoutMs: number;
  /** Tope de espera de GET /me a Compute + Hermes; si se pasa, responde con la fila. */
  budgetMs: number;
  cacheTtlMs: number;
  graceMs: number;
  /** Cada cuánto se repite, como mucho, el evento de 401 de Hermes por usuario. */
  authEventEveryMs?: number;
}

export interface ReadinessDeps {
  repository: AssistantRepository;
  readiness: ReadinessRepository;
  instances: InstanceApi;
  hermes: HermesApi;
  cipher: FieldCipher;
  /**
   * ORQA cliente (OSB-009): se llama sin esperar cuando la fila está `ready`
   * (incluida la transición a ready). Quien lo recibe deduplica y hace config →
   * ack → /health → jobs en segundo plano.
   */
  onReady?: (userId: string, instanceName: string | null, readySince: Date | null) => void;
  now?: () => Date;
}

interface CachedObservation { at: number; instance: string; value: Promise<VmObservation> }

/**
 * Lector de `GET /assistants/me` con readiness real (OCB-008). Observa SOLO
 * cuando el usuario pide su estado (sin bucles ni workers): `instances.get`
 * (estado e IP privada) y `GET /health/detailed` con el API_SERVER_KEY de esa
 * VM (timeout de 3 s), con caché corta por usuario y una sola observación en
 * vuelo. Si la observación no termina dentro del presupuesto, responde con la
 * fila y la observación sigue llenando la caché para la siguiente consulta.
 */
export class ReadinessStateReader implements AssistantStateReader {
  private readonly logger = new Logger('readiness');
  private readonly cache = new Map<string, CachedObservation>();
  private readonly authEvents = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly options: ReadinessOptions, private readonly deps: ReadinessDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async read(userId: string): Promise<AssistantStateV1> {
    const row = await this.deps.repository.findActive(userId);
    if (!needsObservation(row)) return this.answer(row);
    const observation = await this.withinBudget(this.observe(row));
    if (!observation) return this.answer(row);
    return this.answer(await this.apply(row, observation));
  }

  private answer(row: AssistantRow | null): AssistantStateV1 {
    if (row?.status === 'ready' && this.deps.onReady) {
      try {this.deps.onReady(row.user_id, row.instance_name, row.ready_since);} catch {/* segundo plano: nunca rompe GET /me */}
    }
    return toAssistantState(row, this.now());
  }

  /** Re-enqueue the existing callback after managed verification, without observing/applying state. */
  async notifyReady(userId: string): Promise<void> {
    const row = await this.deps.repository.findActive(userId);
    if (row?.status === 'ready') this.deps.onReady?.(row.user_id, row.instance_name, row.ready_since);
  }

  /** Olvida la observación en caché (p. ej. tras configurar la IA). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async apply(row: AssistantRow, observation: VmObservation): Promise<AssistantRow | null> {
    const {repository, readiness} = this.deps;
    if (observation.vm === 'running' && observation.hermes === 'unauthorized') await this.hermesAuthFailed(row.user_id);
    const now = this.now();
    const transition = nextTransition(row, observation, now, this.options.graceMs);
    if (!transition) return row;
    const applied = await readiness.apply(row.user_id, row.step, transition, now);
    if (applied) {
      if (transition.event) {
        await repository.appendEvent({
          userId: row.user_id, kind: transition.event.kind, phase: 'readiness', cause: transition.event.cause, detail: transition.event.detail,
        });
      }
      if (transition.step !== row.step || transition.status !== row.status) {
        this.logger.log(`readiness instance=${row.instance_name} status=${transition.status} step=${transition.step ?? 'none'}`);
      }
    }
    return repository.findActive(row.user_id);
  }

  private observe(row: AssistantRow): Promise<VmObservation> {
    const instance = row.instance_name!;
    const cached = this.cache.get(row.user_id);
    if (cached && cached.instance === instance && this.now().getTime() - cached.at <= this.options.cacheTtlMs) return cached.value;
    const value = this.observeNow(row, instance);
    const entry: CachedObservation = {at: Number.POSITIVE_INFINITY, instance, value};
    this.cache.set(row.user_id, entry);
    // En vuelo cuenta como fresca; al terminar, el TTL corre desde ese momento.
    value.finally(() => {entry.at = this.now().getTime();}).catch(() => undefined);
    return value;
  }

  private async observeNow(row: AssistantRow, instance: string): Promise<VmObservation> {
    let view;
    try {
      view = await this.deps.instances.getInstance(instance);
    } catch {
      return {vm: 'unknown'};
    }
    if (!view) return {vm: 'missing'};
    const phase = vmPhase(view.status);
    if (phase !== 'running') return {vm: phase};
    if (!view.privateIp) return {vm: 'running', ip: null, hermes: 'not_responding'};
    let apiServerKey: string;
    try {
      apiServerKey = this.deps.cipher.open('assistants.api_server_key_enc', row.user_id, row.api_server_key_enc!);
    } catch {
      return {vm: 'unknown'};
    }
    const health = await this.deps.hermes.health({ip: view.privateIp, apiServerKey}, this.options.healthTimeoutMs);
    return {vm: 'running', ip: view.privateIp, hermes: classifyHealth(health)};
  }

  private async withinBudget<T>(work: Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>(resolve => {timer = setTimeout(() => resolve(null), this.options.budgetMs);});
    try {
      return await Promise.race([work.catch(() => null), budget]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async hermesAuthFailed(userId: string): Promise<void> {
    const now = this.now().getTime();
    const last = this.authEvents.get(userId);
    if (last !== undefined && now - last < (this.options.authEventEveryMs ?? 600_000)) return;
    this.authEvents.set(userId, now);
    await this.deps.repository.appendEvent({
      userId, kind: 'readiness.hermes_auth_failed', phase: 'readiness', cause: 'unknown', detail: 'code=HERMES_AUTH_FAILED',
    });
    this.logger.warn('readiness code=HERMES_AUTH_FAILED');
  }
}
