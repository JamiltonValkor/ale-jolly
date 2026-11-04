import type {StreamEventV1} from '../contracts/v1';

/**
 * Normalización del SSE de Hermes v0.21.6 (`/api/sessions/{id}/chat/stream`,
 * api_server.py `_handle_session_chat_stream`) a los eventos v1 del chat.
 *
 * | Hermes                                    | v1                                            |
 * |-------------------------------------------|-----------------------------------------------|
 * | `assistant.delta{delta}`                  | `token{text}`                                 |
 * | `tool.started{tool_name}`                 | `tool_start{name}`                            |
 * | `tool.completed{tool_name}`               | `tool_end{name, ok:true}`                     |
 * | `tool.failed{tool_name}`                  | `tool_end{name, ok:false}`                    |
 * |   … con `mcp__saleads__*`                 |   + `mcp_unavailable` (no cierra el turno)    |
 * | `assistant.completed{completed,content}`  | se recuerda; si no hubo deltas, el content    |
 * |                                           | completo sale como un `token`                 |
 * | `run.completed`                           | `message_end` (fin)                           |
 * | `run.failed`                              | `provider_error{reason}` o `error` (fin)      |
 * | `run.cancelled`                           | `error` (fin)                                 |
 * | `error{message}`                          | `provider_error{reason}` o `error` (fin)      |
 * | `done` sin evento run.* previo            | según `assistant.completed`; si no, corte     |
 * | corte sin run.* (EOF, red, inactividad)   | `assistant_restarting` si la VM sigue RUNNING |
 * |                                           | (reinicio del gateway, OCB-016); si no, `error` |
 * | solo con `voice`:                         |                                               |
 * | `assistant.commentary{text}` sin          | `commentary{text}`                            |
 * |   `already_streamed` (ya salió en deltas) |                                               |
 * | `tool.progress{tool_name:_thinking}`      | `thinking` (una vez por turno, sin el texto)  |
 * | `run.started`, `message.started`,         | se ignoran                                    |
 * | `tool.progress`, `assistant.commentary`   |                                               |
 * |   (sin `voice`), `approval.request`,      |                                               |
 * |   keepalives `:`, otros                   |                                               |
 *
 * El texto de los fallos solo se usa aquí para clasificarlos: nunca sale en el
 * evento v1, nunca se guarda y nunca se registra (privacidad, invariante 4).
 */

export const MCP_TOOL_PREFIX = 'mcp__saleads__';
const MAX_NAME = 200;
const MAX_FAILURE_TEXT = 4000;

export type ProviderReason = 'auth' | 'quota' | 'rate_limit';

/**
 * Textos de Hermes (agent/turn_failure_copy.py @818c13be) y de los proveedores:
 * - auth: «{label} rejected your API key…», «…rejected your sign-in» (G-07: «… HTTP 401»).
 * - quota: «…usage or credit limit is reached» (billing), `insufficient_quota` de OpenAI, 402.
 * - rate_limit: «{label} rate-limited every one of N attempts», «is rate-limiting requests», 429.
 * La cuota va antes que el 429 porque OpenAI responde `insufficient_quota` con HTTP 429.
 */
const AUTH = /rejected your api key|rejected (?:your|the) sign-in|invalid[ _-]?api[ _-]?key|incorrect api key|unauthori[sz]ed|authentication (?:failed|error)|\b401\b/i;
const QUOTA = /insufficient[ _-]?quota|exceeded your current quota|\bquota\b|credit limit|out of credits|insufficient (?:credits|funds|balance)|\bbilling\b|payment required|\b402\b/i;
const RATE_LIMIT = /rate[ -]?limit|too many requests|\b429\b/i;

/** `turn_exit_reason` de `run.failed` cuando trae el FailoverReason de Hermes. */
const EXIT_REASONS: Record<string, ProviderReason> = {
  auth: 'auth', auth_permanent: 'auth',
  billing: 'quota', billing_unverified: 'quota',
  rate_limit: 'rate_limit', upstream_rate_limit: 'rate_limit', nous_rate_limit: 'rate_limit',
};

export function classifyProviderFailure(text: string, exitReason?: string | null): ProviderReason | null {
  const byReason = exitReason ? EXIT_REASONS[exitReason] : undefined;
  if (byReason) return byReason;
  if (AUTH.test(text)) return 'auth';
  if (QUOTA.test(text)) return 'quota';
  if (RATE_LIMIT.test(text)) return 'rate_limit';
  return null;
}

export interface HermesSseEvent { event: string; data: unknown }

export interface NormalizedStep {
  events: StreamEventV1[];
  /** El turno terminó (el último de `events` es message_end, provider_error o error). */
  terminal: boolean;
  /** Tool MCP que falló: se reporta a la renovación (OCB-009). */
  mcpToolFailed?: string;
  /** `done` sin run.* ni `assistant.completed`: el turno quedó cortado (lo cierra el relay). */
  cut?: boolean;
}

/** Resumen sin contenido para el log del turno. */
export interface TurnSummary {
  runId: string | null;
  lastSeq: number | null;
  outcome: 'message_end' | 'provider_error' | 'error' | 'assistant_restarting' | null;
  reason: ProviderReason | null;
  tokens: number;
  /** `usage.input_tokens` de `run.completed`, si Hermes lo manda. `tokens` cuenta fragmentos, no consumo. */
  inputTokens: number | null;
  tools: number;
  mcpFailures: number;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, MAX_FAILURE_TEXT) : '';
const toolName = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_NAME) : null;

/** Máquina de estados de un turno. Una instancia por turno. */
export class HermesTurnNormalizer {
  private finished = false;
  private tokens = 0;
  private inputTokens: number | null = null;
  private tools = 0;
  private mcpFailures = 0;
  private runId: string | null = null;
  private lastSeq: number | null = null;
  private outcome: TurnSummary['outcome'] = null;
  private reason: ProviderReason | null = null;
  /** `assistant.completed`: completed y content (solo para clasificar o para el token de respaldo). */
  private completion: {completed: boolean; content: string} | null = null;
  private readonly voice: boolean;
  private thinking = false;

  constructor(options: {voice?: boolean} = {}) {this.voice = options.voice === true;}

  get done(): boolean {return this.finished;}

  push({event, data}: HermesSseEvent): NormalizedStep {
    if (this.finished) return {events: [], terminal: true};
    const payload = record(data);
    if (typeof payload.run_id === 'string' && RUN_ID.test(payload.run_id)) this.runId = payload.run_id;
    if (typeof payload.seq === 'number' && Number.isFinite(payload.seq)) this.lastSeq = payload.seq;

    switch (event) {
      case 'assistant.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (!delta) return {events: [], terminal: false};
        this.tokens++;
        return {events: [{type: 'token', text: delta}], terminal: false};
      }
      case 'tool.started': {
        const name = toolName(payload.tool_name);
        if (!name) return {events: [], terminal: false};
        this.tools++;
        return {events: [{type: 'tool_start', name}], terminal: false};
      }
      case 'tool.completed': {
        const name = toolName(payload.tool_name);
        return {events: name ? [{type: 'tool_end', name, ok: true}] : [], terminal: false};
      }
      case 'tool.failed': {
        const name = toolName(payload.tool_name);
        if (!name) return {events: [], terminal: false};
        const events: StreamEventV1[] = [{type: 'tool_end', name, ok: false}];
        // Solo las tools del MCP de SaleADS: los fallos de terminal/web_search/… no cuentan (OCB-002).
        if (!name.startsWith(MCP_TOOL_PREFIX)) return {events, terminal: false};
        this.mcpFailures++;
        events.push({type: 'mcp_unavailable'});
        return {events, terminal: false, mcpToolFailed: name};
      }
      case 'assistant.completed': {
        this.completion = {completed: payload.completed !== false, content: text(payload.content)};
        if (this.completion.completed && this.tokens === 0 && this.completion.content) {
          this.tokens++;
          return {events: [{type: 'token', text: this.completion.content}], terminal: false};
        }
        return {events: [], terminal: false};
      }
      case 'assistant.commentary': {
        const commentary = typeof payload.text === 'string' ? payload.text : '';
        if (!this.voice || payload.already_streamed === true || !commentary.trim()) return {events: [], terminal: false};
        return {events: [{type: 'commentary', text: commentary}], terminal: false};
      }
      case 'tool.progress': {
        if (!this.voice || this.thinking || payload.tool_name !== '_thinking') return {events: [], terminal: false};
        this.thinking = true;
        return {events: [{type: 'thinking'}], terminal: false};
      }
      case 'run.completed': {
        const usage = payload.usage as {input_tokens?: unknown} | undefined;
        if (typeof usage?.input_tokens === 'number') this.inputTokens = usage.input_tokens;
        return this.finish({type: 'message_end'});
      }
      case 'run.failed':
        return this.failed(`${this.completion?.content ?? ''}\n${text(payload.error)}`,
          typeof payload.turn_exit_reason === 'string' ? payload.turn_exit_reason : null);
      case 'run.cancelled':
        return this.finish({type: 'error'});
      case 'error':
        return this.failed(text(payload.message), null);
      case 'done':
        return this.completion ? this.end() : {events: [], terminal: false, cut: true};
      default:
        return {events: [], terminal: false};
    }
  }

  /** El stream de Hermes se cerró (o `done`): cierra el turno si nada lo cerró. */
  end(): NormalizedStep {
    if (this.finished) return {events: [], terminal: true};
    if (!this.completion) return this.finish({type: 'error'});
    if (this.completion.completed) return this.finish({type: 'message_end'});
    return this.failed(this.completion.content, null);
  }

  /** Corte sin evento final (Hermes caído, upstream inactivo): `error`. */
  abort(): NormalizedStep {
    return this.finished ? {events: [], terminal: true} : this.finish({type: 'error'});
  }

  /**
   * ¿Cerrar ahora daría `error` por falta de un final? Con `streamEnded` (EOF o
   * `done`) solo si Hermes no mandó `assistant.completed`; tras un corte de red
   * o inactividad, siempre que el turno siga abierto.
   */
  missingFinal(streamEnded: boolean): boolean {
    return !this.finished && (!streamEnded || !this.completion);
  }

  /** Hermes se está reiniciando con la VM encendida (OCB-016): cierra el turno. */
  restarting(): NormalizedStep {
    return this.finished ? {events: [], terminal: true} : this.finish({type: 'assistant_restarting'});
  }

  summary(): TurnSummary {
    return {runId: this.runId, lastSeq: this.lastSeq, outcome: this.outcome, reason: this.reason,
      tokens: this.tokens, inputTokens: this.inputTokens, tools: this.tools, mcpFailures: this.mcpFailures};
  }

  private failed(failureText: string, exitReason: string | null): NormalizedStep {
    const reason = classifyProviderFailure(failureText, exitReason);
    if (!reason) return this.finish({type: 'error'});
    this.reason = reason;
    return this.finish({type: 'provider_error', reason});
  }

  private finish(event: StreamEventV1): NormalizedStep {
    this.finished = true;
    this.outcome = event.type as TurnSummary['outcome'];
    return {events: [event], terminal: true};
  }
}

/** Marco SSE v1: el tipo en `event:` y el resto del objeto como JSON en `data:`. */
export function sseFrame(event: StreamEventV1): string {
  const {type, ...rest} = event;
  return `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`;
}
