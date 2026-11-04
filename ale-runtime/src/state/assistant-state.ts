import type {AssistantStateV1} from '../contracts/v1';
import type {AssistantRepository, AssistantRow} from '../persistence/assistant-repository';

/** Lectura del estado del asistente del usuario (`GET /assistants/me`). */
export interface AssistantStateReader { read(userId: string): Promise<AssistantStateV1> }
export const ASSISTANT_STATE_READER = Symbol('ASSISTANT_STATE_READER');

export const NO_ASSISTANT: AssistantStateV1 = Object.freeze({
  status: 'none',
  step: null,
  slow: false,
  session_id: null,
  ai: Object.freeze({configured: false, provider: null, model: null}),
  ready_since: null,
  timezone: null,
});

/**
 * Lector del esqueleto (OCB-006): todavía no existe la activación (OCB-007), así
 * que ningún usuario tiene asistente. OCB-008 lo reemplaza por el lector real
 * sobre `assistant.assistants` y la readiness de la VM.
 */
export class SkeletonAssistantStateReader implements AssistantStateReader {
  async read(_userId: string): Promise<AssistantStateV1> {
    return NO_ASSISTANT;
  }
}

/** Tras 5 minutos de preparación sin llegar a configure_ai, el front avisa (OCB-008). */
export const SLOW_AFTER_MS = 5 * 60_000;

/**
 * Proyección de la fila a `AssistantStateV1`, sin consultar la VM. OCB-008
 * agrega la readiness de Hermes (installing_agent → configure_ai) y el hito de
 * `ready_since`; OCB-010 fija status=ready.
 */
export function toAssistantState(row: AssistantRow | null, now: Date): AssistantStateV1 {
  if (!row || row.deleted_at) return NO_ASSISTANT;
  const activating = row.status === 'activating';
  const step = activating ? row.step : null;
  const started = row.activation_started_at?.getTime();
  return {
    status: row.status,
    step,
    slow: activating && step !== 'configure_ai' && started !== undefined && now.getTime() - started > SLOW_AFTER_MS,
    session_id: row.session_id,
    ai: {configured: row.ai_configured, provider: row.ai_provider, model: row.ai_model},
    ready_since: row.ready_since ? row.ready_since.toISOString() : null,
    timezone: row.timezone ?? null,
  };
}

/** Lector del estado desde la fila (OCB-007). OCB-008 lo extiende con la readiness. */
export class RowAssistantStateReader implements AssistantStateReader {
  constructor(private readonly repository: AssistantRepository, private readonly now: () => Date = () => new Date()) {}

  async read(userId: string): Promise<AssistantStateV1> {
    return toAssistantState(await this.repository.findActive(userId), this.now());
  }
}
