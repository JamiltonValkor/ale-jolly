import type {OutboundFetch} from '../outbound/http-client';

/**
 * Cliente del API server de Hermes v0.21.6 en la VM del usuario
 * (`http://<ip-privada>:8642`, Bearer = API_SERVER_KEY de esa VM).
 *
 * Nunca registra la key, la IP con credenciales, el texto del turno de prueba
 * ni los mensajes de error de Hermes (pueden citar al proveedor).
 */

export interface HermesTarget { ip: string; apiServerKey: string }

/** Lo que dijo `GET /health/detailed` (OCB-008). */
export type HealthObservation =
  | {kind: 'unreachable'}
  | {kind: 'unauthorized'}
  | {kind: 'http_error'; status: number}
  | {kind: 'answered'; platform: string | null; status: string | null; checks: Record<string, string>};

/** Resultado del turno mínimo de prueba (OCB-010). `text` solo sirve para clasificar; nunca se guarda. */
export type ProbeOutcome =
  | {kind: 'completed'}
  | {kind: 'failed'; text: string}
  | {kind: 'unauthorized'}
  | {kind: 'unreachable'; reason: string};

export interface HermesApi {
  health(target: HermesTarget, timeoutMs: number): Promise<HealthObservation>;
  probeTurn(target: HermesTarget, message: string, timeoutMs: number): Promise<ProbeOutcome>;
}

/** Crear (o confirmar) la sesión del chat: 201 o 409 de Hermes = existe (OCB-011). */
export type SessionOutcome = {kind: 'ok'} | {kind: 'unauthorized'} | {kind: 'unreachable'; reason: string}
  /** Hermes respondió y no aceptó la sesión (4xx): no es un reinicio. IVB-023: `invalid_title` se tomaba por «reiniciando». */
  | {kind: 'rejected'; status: number; code: string | null};

/** Sufijo estable de una sesión: los 8 primeros del id tras su prefijo (`saleads-flow-`, `robot-`). */
export function sessionShortId(sessionId: string): string {
  return sessionId.replace(/^(saleads-flow-|saleads-|robot-)/, '').slice(0, 8) || sessionId.slice(0, 8);
}

/** Fila cruda de `GET /api/sessions/{id}/messages` (`_message_response` de Hermes). */
export interface HermesMessage { id?: unknown; role?: unknown; content?: unknown; timestamp?: unknown; display_kind?: unknown }

export type MessagesOutcome =
  | {kind: 'ok'; messages: HermesMessage[]}
  | {kind: 'not_found'}
  | {kind: 'unauthorized'}
  | {kind: 'unreachable'; reason: string};

/** Apertura de `POST /api/sessions/{id}/chat/stream`. `busy` = 429 de Hermes (tope de turnos simultáneos). */
export type StreamOpening =
  | {kind: 'open'; body: ReadableStream<Uint8Array>}
  | {kind: 'not_found'}
  | {kind: 'unauthorized'}
  | {kind: 'busy'}
  | {kind: 'unreachable'; reason: string};

/** Sessions API de Hermes para el chat del dueño (OCB-011). */
export interface HermesChatApi {
  /** `title` debe ser único entre sesiones (Hermes responde 400 invalid_title si se repite). */
  ensureSession(target: HermesTarget, sessionId: string, timeoutMs: number, title?: string, source?: string): Promise<SessionOutcome>;
  messages(target: HermesTarget, sessionId: string, timeoutMs: number): Promise<MessagesOutcome>;
  /** `signal` corta la conexión con Hermes (cliente que cancela o upstream inactivo). */
  openStream(target: HermesTarget, sessionId: string, message: string, signal: AbortSignal, options?: TurnOptions): Promise<StreamOpening>;
}

/**
 * `voice`: turno hablado (razonamiento corto, ver `VOICE_MODEL_OPTIONS`).
 * `instructions`: instrucción de sistema EFÍMERA de ese turno (Hermes `instructions` → ephemeral_system_prompt):
 * no queda como mensaje del dueño en la sesión.
 */
export interface TurnOptions { voice?: boolean; instructions?: string }

/**
 * `model_options` de un turno hablado: `_runtime_options_from_model_options`
 * lo vuelve `reasoning_config {enabled, effort: low}` solo para ese turno.
 */
export const VOICE_MODEL_OPTIONS = {reasoning: {effort: 'low'}} as const;

/** Trabajo programado tal como lo crea SaleADS (`POST /api/jobs`, OSB-009). */
export interface HermesJobInput { name: string; schedule: string; prompt: string; skills: string[]; deliver: string }

/**
 * Trabajo vivo de `GET /api/jobs` (MCB-003). De `origin` solo se leen `platform` y `chat_id`: las IPs y el
 * `user_agent` que Hermes guarda ahí no se copian. `schedule` no se lee: SaleADS nunca toca el horario.
 */
export interface HermesJobView {
  id: string;
  name: string;
  prompt: string;
  skills: string[];
  /** `enabled`, o `state !== 'paused'`; null si Hermes no dice ninguno. */
  enabled: boolean | null;
  origin: {platform: string | null; chatId: string | null};
}

export type JobsListOutcome =
  | {kind: 'ok'; names: string[]; jobs: HermesJobView[]}
  | {kind: 'unauthorized'}
  | {kind: 'unreachable'; reason: string};

export type JobCreateOutcome = {kind: 'created'} | {kind: 'rejected'; status: number} | {kind: 'unauthorized'} | {kind: 'unreachable'; reason: string};

/** Lo único que SaleADS cambia de un trabajo existente (D21): su texto. Nunca horario, encendido ni entrega. */
export interface JobTextPatch { prompt?: string; skills?: string[] }

export type JobUpdateOutcome =
  | {kind: 'updated'}
  | {kind: 'rejected'; status: number}
  | {kind: 'not_found'}
  | {kind: 'unauthorized'}
  | {kind: 'unreachable'; reason: string};

/** Cron API de Hermes (`gateway/platforms/api_server.py` @818c13be). */
export interface HermesJobsApi {
  /** `GET /api/jobs?include_disabled=true`: todos los trabajos, también los pausados. */
  listJobs(target: HermesTarget, timeoutMs: number): Promise<JobsListOutcome>;
  createJob(target: HermesTarget, job: HermesJobInput, timeoutMs: number): Promise<JobCreateOutcome>;
  /** `PATCH /api/jobs/{id}` con solo `prompt` y/o `skills` (MCB-003). */
  updateJob(target: HermesTarget, id: string, patch: JobTextPatch, timeoutMs: number): Promise<JobUpdateOutcome>;
}

/** `_JOB_ID_RE` de Hermes (`api_server.py`): un id que no lo cumple ni se manda. */
const JOB_ID = /^[a-f0-9]{12}$/;

const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** Arma la vista de forma defensiva: una fila sin `id` o `name` de tipo string se descarta. */
function jobView(raw: unknown): HermesJobView | null {
  if (!raw || typeof raw !== 'object') return null;
  const job = raw as Record<string, unknown>;
  if (typeof job.id !== 'string' || typeof job.name !== 'string') return null;
  const skills = Array.isArray(job.skills) ? job.skills.filter((skill): skill is string => typeof skill === 'string')
    : typeof job.skill === 'string' && job.skill ? [job.skill] : [];
  const enabled = typeof job.enabled === 'boolean' ? job.enabled : typeof job.state === 'string' ? job.state !== 'paused' : null;
  const origin = job.origin && typeof job.origin === 'object' ? job.origin as Record<string, unknown> : {};
  return {
    id: job.id, name: job.name, prompt: typeof job.prompt === 'string' ? job.prompt : '', skills, enabled,
    origin: {platform: stringOrNull(origin.platform), chatId: stringOrNull(origin.chat_id)},
  };
}

/** Sesión propia del turno de prueba: no toca la conversación del dueño (OCB-011 usa otra). */
export const PROBE_SESSION_ID = 'saleads-ai-check';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const RUN_TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const MAX_FAILURE_TEXT = 2000;

interface SseEvent { event: string; data: unknown }

/** Parser SSE mínimo (`event:` + `data:`; comentarios `:` = keepalive). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
      buffer = buffer.replace(/\r\n?/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        let parsed: unknown = null;
        try {parsed = JSON.parse(data.join('\n'));} catch {parsed = null;}
        yield {event, data: parsed};
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

const textOf = (value: unknown): string => typeof value === 'string' ? value.slice(0, MAX_FAILURE_TEXT) : '';

export class HttpHermesClient implements HermesApi, HermesChatApi, HermesJobsApi {
  /**
   * `streamFetcher`: transporte del chat. Su plazo total es el tope de un turno
   * (el `fetcher` normal corta a los 45 s, lo que mataría un turno largo).
   */
  constructor(
    private readonly fetcher: OutboundFetch,
    private readonly port: number,
    private readonly streamFetcher: OutboundFetch = fetcher,
  ) {}

  /**
   * `POST /api/sessions {id, title}`: Hermes acepta el id del cliente y responde
   * 409 si ya existe (api_server.py `_handle_create_session`), así que 201 y 409
   * significan lo mismo: la sesión está.
   */
  /**
   * Hermes exige títulos únicos: con un título repetido responde 400 `invalid_title`, aunque el id sea nuevo. Se reintenta una
   * vez con el sufijo del id, que es único. IVB-023: la primera sesión de un flujo nacida por voz chocaba con `saleads-main`.
   */
  async ensureSession(target: HermesTarget, sessionId: string, timeoutMs: number, title = 'SaleADS', source?: string): Promise<SessionOutcome> {
    const first = await this.createSession(target, sessionId, timeoutMs, title, source);
    if (first.kind !== 'rejected' || first.code !== 'invalid_title') return first;
    const suffix = sessionShortId(sessionId);
    return this.createSession(target, sessionId, timeoutMs, title.endsWith(suffix) ? `${title} ${sessionId.slice(-8)}` : `${title} ${suffix}`, source);
  }

  private async createSession(target: HermesTarget, sessionId: string, timeoutMs: number, title: string, source?: string): Promise<SessionOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base(target)}/api/sessions`, {
        method: 'POST', headers: this.headers(target, true), signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(source ? {id: sessionId, title, source} : {id: sessionId, title}),
      });
    } catch {
      return {kind: 'unreachable', reason: 'network'};
    }
    if (response.status === 401 || response.status === 403) {await this.drain(response); return {kind: 'unauthorized'};}
    if (response.ok || response.status === 409) {await this.drain(response); return {kind: 'ok'};}
    if (response.status >= 400 && response.status < 500) {
      let code: string | null = null;
      try {
        const body = await response.json() as {error?: {code?: unknown}} | null;
        code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 64) : null;
      } catch {/* cuerpo ilegible: queda sin código */}
      return {kind: 'rejected', status: response.status, code};
    }
    await this.drain(response);
    return {kind: 'unreachable', reason: `session_${response.status}`};
  }

  /** `GET /api/sessions/{id}/messages`: por defecto, la última página de 500 en orden cronológico. */
  async messages(target: HermesTarget, sessionId: string, timeoutMs: number): Promise<MessagesOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base(target)}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: this.headers(target), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return {kind: 'unreachable', reason: 'network'};
    }
    if (response.status === 401 || response.status === 403) {await this.drain(response); return {kind: 'unauthorized'};}
    if (response.status === 404) {await this.drain(response); return {kind: 'not_found'};}
    if (!response.ok) {await this.drain(response); return {kind: 'unreachable', reason: `messages_${response.status}`};}
    let body: {data?: unknown} | null;
    try {body = await response.json() as {data?: unknown} | null;} catch {return {kind: 'unreachable', reason: 'messages_body'};}
    const data = Array.isArray(body?.data) ? body.data : [];
    return {kind: 'ok', messages: data.filter((item): item is HermesMessage => !!item && typeof item === 'object')};
  }

  /**
   * `POST /api/sessions/{id}/chat/stream {message}` (`_session_chat_user_message` acepta `message` o `input`).
   * Con `voice` agrega `model_options` (solo ese turno).
   */
  async openStream(
    target: HermesTarget, sessionId: string, message: string, signal: AbortSignal, options: TurnOptions = {},
  ): Promise<StreamOpening> {
    let response: Response;
    try {
      response = await this.streamFetcher(`${this.base(target)}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
        method: 'POST', headers: {...this.headers(target, true), accept: 'text/event-stream'}, signal,
        body: JSON.stringify({
          message,
          ...(options.voice ? {model_options: VOICE_MODEL_OPTIONS} : {}),
          ...(options.instructions ? {instructions: options.instructions} : {}),
        }),
      });
    } catch {
      return {kind: 'unreachable', reason: signal.aborted ? 'aborted' : 'network'};
    }
    if (response.ok && response.body && response.headers.get('content-type')?.startsWith('text/event-stream')) {
      return {kind: 'open', body: response.body};
    }
    await this.drain(response);
    if (response.status === 401 || response.status === 403) return {kind: 'unauthorized'};
    if (response.status === 404) return {kind: 'not_found'};
    if (response.status === 429) return {kind: 'busy'};
    return {kind: 'unreachable', reason: `stream_${response.status}`};
  }

  async listJobs(target: HermesTarget, timeoutMs: number): Promise<JobsListOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base(target)}/api/jobs?include_disabled=true`, {
        headers: this.headers(target), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return {kind: 'unreachable', reason: 'network'};
    }
    if (response.status === 401 || response.status === 403) {await this.drain(response); return {kind: 'unauthorized'};}
    if (!response.ok) {await this.drain(response); return {kind: 'unreachable', reason: `jobs_${response.status}`};}
    let body: {jobs?: unknown} | null;
    try {body = await response.json() as {jobs?: unknown} | null;} catch {return {kind: 'unreachable', reason: 'jobs_body'};}
    if (!Array.isArray(body?.jobs)) return {kind: 'unreachable', reason: 'jobs_body'};
    const names = body.jobs.map(job => (job as {name?: unknown} | null)?.name).filter((name): name is string => typeof name === 'string');
    const jobs = body.jobs.map(jobView).filter((job): job is HermesJobView => job !== null);
    return {kind: 'ok', names, jobs};
  }

  /**
   * `PATCH /api/jobs/{id}`: el cuerpo lleva solo las claves de `patch` (nunca `enabled`, `schedule`,
   * `deliver`, `name` ni `repeat`), así Hermes conserva la pausa y el horario. Sin claves, no llama.
   * El cuerpo del error no se lee: puede citar el prompt (el escáner de Hermes responde 400).
   */
  async updateJob(target: HermesTarget, id: string, patch: JobTextPatch, timeoutMs: number): Promise<JobUpdateOutcome> {
    if (!JOB_ID.test(id)) return {kind: 'rejected', status: 0};
    const body: JobTextPatch = {};
    if (patch.prompt !== undefined) body.prompt = patch.prompt;
    if (patch.skills !== undefined) body.skills = [...patch.skills];
    if (!Object.keys(body).length) return {kind: 'rejected', status: 0};
    let response: Response;
    try {
      response = await this.fetcher(`${this.base(target)}/api/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: this.headers(target, true), signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
      });
    } catch {
      return {kind: 'unreachable', reason: 'network'};
    }
    await this.drain(response);
    if (response.status === 401 || response.status === 403) return {kind: 'unauthorized'};
    if (response.status === 404) return {kind: 'not_found'};
    if (response.ok) return {kind: 'updated'};
    if (response.status >= 400 && response.status < 500) return {kind: 'rejected', status: response.status};
    return {kind: 'unreachable', reason: `job_${response.status}`};
  }

  /** `POST /api/jobs`. El cuerpo del error de Hermes no se lee: puede citar el prompt. */
  async createJob(target: HermesTarget, job: HermesJobInput, timeoutMs: number): Promise<JobCreateOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base(target)}/api/jobs`, {
        method: 'POST', headers: this.headers(target, true), signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(job),
      });
    } catch {
      return {kind: 'unreachable', reason: 'network'};
    }
    await this.drain(response);
    if (response.status === 401 || response.status === 403) return {kind: 'unauthorized'};
    if (response.ok) return {kind: 'created'};
    if (response.status >= 400 && response.status < 500) return {kind: 'rejected', status: response.status};
    return {kind: 'unreachable', reason: `job_${response.status}`};
  }

  async health(target: HermesTarget, timeoutMs: number): Promise<HealthObservation> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base(target)}/health/detailed`, {
        headers: this.headers(target), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return {kind: 'unreachable'};
    }
    if (response.status === 401 || response.status === 403) {await this.drain(response); return {kind: 'unauthorized'};}
    if (!response.ok) {await this.drain(response); return {kind: 'http_error', status: response.status};}
    type Detailed = {platform?: unknown; status?: unknown; readiness?: {checks?: unknown}} | null;
    let body: Detailed;
    try {body = await response.json() as Detailed;} catch {return {kind: 'http_error', status: 502};}
    const checks: Record<string, string> = {};
    const raw = body?.readiness?.checks;
    if (raw && typeof raw === 'object') {
      for (const [name, check] of Object.entries(raw as Record<string, unknown>)) {
        const status = (check as {status?: unknown} | null)?.status;
        checks[name] = typeof status === 'string' ? status : 'unknown';
      }
    }
    return {
      kind: 'answered',
      platform: typeof body?.platform === 'string' ? body.platform : null,
      status: typeof body?.status === 'string' ? body.status : null,
      checks,
    };
  }

  /**
   * Turno mínimo por la Sessions API con SSE (`/api/sessions/{id}/chat/stream`).
   * Se eligió este camino y no `/v1/chat/completions` porque, en dev, una key
   * rechazada vuelve por completions como TEXTO del assistant con HTTP 200,
   * mientras que el SSE cierra con `run.failed` (G-07 de OCB-002): el veredicto
   * sale del evento terminal, no de adivinar el texto. El texto de
   * `assistant.completed` (o de `error`) solo se usa para clasificar el fallo.
   * La sesión de prueba se borra antes y después, así no se acumula historial.
   */
  async probeTurn(target: HermesTarget, message: string, timeoutMs: number): Promise<ProbeOutcome> {
    const signal = AbortSignal.timeout(timeoutMs);
    const session = `${this.base(target)}/api/sessions/${PROBE_SESSION_ID}`;
    try {
      await this.deleteProbeSession(session, target, signal);
      const created = await this.fetcher(`${this.base(target)}/api/sessions`, {
        method: 'POST', headers: this.headers(target, true), signal,
        body: JSON.stringify({id: PROBE_SESSION_ID, title: 'SaleADS AI check'}),
      });
      await this.drain(created);
      if (created.status === 401 || created.status === 403) return {kind: 'unauthorized'};
      if (!created.ok && created.status !== 409) return {kind: 'unreachable', reason: `session_${created.status}`};

      const stream = await this.fetcher(`${session}/chat/stream`, {
        method: 'POST', headers: {...this.headers(target, true), accept: 'text/event-stream'}, signal,
        body: JSON.stringify({message}),
      });
      if (stream.status === 401 || stream.status === 403) {await this.drain(stream); return {kind: 'unauthorized'};}
      if (!stream.ok || !stream.body) {await this.drain(stream); return {kind: 'unreachable', reason: `stream_${stream.status}`};}

      let assistantText = '';
      let errorText = '';
      let terminal: string | null = null;
      for await (const {event, data} of readSse(stream.body)) {
        const payload = (data ?? {}) as Record<string, unknown>;
        if (event === 'assistant.completed') assistantText = textOf(payload.content);
        if (event === 'error') {errorText = textOf(payload.message); terminal ??= 'error';}
        if (RUN_TERMINAL.has(event)) {terminal ??= event; break;}
        if (event === 'done') break;
      }
      if (terminal === 'run.completed') return {kind: 'completed'};
      if (terminal === 'run.failed' || terminal === 'error') return {kind: 'failed', text: `${assistantText}\n${errorText}`.trim()};
      return {kind: 'unreachable', reason: terminal === 'run.cancelled' ? 'cancelled' : 'stream_ended'};
    } catch {
      return {kind: 'unreachable', reason: signal.aborted ? 'timeout' : 'network'};
    } finally {
      // Limpieza best effort con su propio plazo corto.
      await this.deleteProbeSession(session, target, AbortSignal.timeout(3000)).catch(() => undefined);
    }
  }

  private async deleteProbeSession(url: string, target: HermesTarget, signal: AbortSignal): Promise<void> {
    const response = await this.fetcher(url, {method: 'DELETE', headers: this.headers(target), signal});
    await this.drain(response);
  }

  private base(target: HermesTarget): string {
    if (!IPV4.test(target.ip)) throw new Error('HERMES_TARGET_INVALID');
    return `http://${target.ip}:${this.port}`;
  }

  private headers(target: HermesTarget, json = false): Record<string, string> {
    return {authorization: `Bearer ${target.apiServerKey}`, accept: 'application/json', ...(json ? {'content-type': 'application/json'} : {})};
  }

  private async drain(response: Response): Promise<void> {
    try {await response.body?.cancel();} catch {/* ya consumido */}
  }
}
