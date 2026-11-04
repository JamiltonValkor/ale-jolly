import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

/**
 * Hermes v0.21.6 simulado por HTTP real (Sessions API, api_server.py @818c13be):
 * `POST /api/sessions` (201/409), `GET /api/sessions/{id}/messages` y
 * `POST /api/sessions/{id}/chat/stream` con el marco SSE real: `event:` +
 * `data: <json>` con `session_id`, `run_id`, `seq` y `ts`, y comentarios
 * `: keepalive` entre eventos (CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS).
 */

export type ScriptStep =
  | {event: string; data?: Record<string, unknown>}
  | {keepalive: true}
  | {wait: Promise<void>}
  | {raw: string}
  /** Corta la conexión sin `done` (Hermes caído a mitad). */
  | {destroy: true}
  /** Se queda callado (sin keepalive) hasta que el cliente corte. */
  | {hang: true};

export interface StreamRequestLog { sessionId: string; body: unknown; authorization: string | undefined }

export class FakeHermesServer {
  readonly apiKey: string;
  readonly sessions = new Set<string>();
  readonly sessionPosts: Array<{body: unknown; authorization: string | undefined}> = [];
  /** Como Hermes real: un título solo puede tenerlo una sesión (400 `invalid_title`). Apagado por defecto. */
  uniqueTitles = false;
  readonly titles = new Map<string, string>();
  readonly streamRequests: StreamRequestLog[] = [];
  messages: unknown[] = [];
  /** Guion del próximo turno (uno por llamada a /chat/stream). */
  scripts: ScriptStep[][] = [];
  /** Status HTTP forzado para la próxima apertura del stream (404, 429…). */
  streamStatus: number[] = [];
  /** Resuelve cuando la conexión del stream en curso se cierra (el cliente cortó). */
  clientClosed: Promise<void> = Promise.resolve();
  private server: Server | null = null;
  private seq = 0;

  constructor(apiKey: string) {this.apiKey = apiKey;}

  get port(): number {return (this.server!.address() as AddressInfo).port;}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {void this.handle(req, res);});
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (req.headers.authorization !== `Bearer ${this.apiKey}`) return json(res, 401, {error: {message: 'Invalid API key'}});
    const url = new URL(req.url ?? '/', 'http://hermes');
    const match = /^\/api\/sessions\/([^/]+)\/(messages|chat\/stream)$/.exec(url.pathname);
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      this.sessionPosts.push({body, authorization: req.headers.authorization});
      const id = String((body as {id?: unknown}).id);
      if (this.sessions.has(id)) return json(res, 409, {error: {message: `Session already exists: ${id}`, code: 'session_exists'}});
      const title = String((body as {title?: unknown}).title ?? '');
      if (this.uniqueTitles && this.titles.has(title) && this.titles.get(title) !== id) {
        return json(res, 400, {error: {message: `Title '${title}' is already in use by session ${this.titles.get(title)}`, type: 'invalid_request_error', param: null, code: 'invalid_title'}});
      }
      this.titles.set(title, id);
      this.sessions.add(id);
      return json(res, 201, {object: 'hermes.session', session: {id}});
    }
    if (req.method === 'GET' && match?.[2] === 'messages') {
      if (!this.sessions.has(decodeURIComponent(match[1]!))) return json(res, 404, {error: {code: 'session_not_found'}});
      return json(res, 200, {object: 'list', session_id: match[1], data: this.messages, pagination: {}});
    }
    if (req.method === 'POST' && match?.[2] === 'chat/stream') {
      const sessionId = decodeURIComponent(match[1]!);
      this.streamRequests.push({sessionId, body, authorization: req.headers.authorization});
      const forced = this.streamStatus.shift();
      if (forced) return json(res, forced, {error: {message: 'forced'}});
      if (!this.sessions.has(sessionId)) return json(res, 404, {error: {code: 'session_not_found'}});
      return this.stream(sessionId, req, res, this.scripts.shift() ?? []);
    }
    return json(res, 404, {error: {code: 'not_found'}});
  }

  private async stream(sessionId: string, req: IncomingMessage, res: ServerResponse, script: ScriptStep[]): Promise<void> {
    const runId = `run_${Math.random().toString(16).slice(2, 10)}`;
    let closed!: () => void;
    this.clientClosed = new Promise<void>(resolve => {closed = resolve;});
    res.on('close', () => closed());
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Hermes-Session-Id': sessionId});
    res.flushHeaders();
    for (const step of script) {
      if (res.destroyed) return;
      if ('wait' in step) {await step.wait; continue;}
      if ('keepalive' in step) {res.write(': keepalive\n\n'); continue;}
      if ('raw' in step) {res.write(step.raw); continue;}
      if ('destroy' in step) {res.destroy(); return;}
      if ('hang' in step) {await this.clientClosed; return;}
      const payload = {...step.data, session_id: sessionId, run_id: runId, seq: ++this.seq, ts: Date.now() / 1000};
      res.write(`event: ${step.event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    if (!res.destroyed) res.end();
    void req;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {resolve(text ? JSON.parse(text) : {});} catch {resolve({});}
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

/** Fragmentos del SSE real de OCB-002 (G-06/G-07), sin contenido privado. */
export const MSG = 'msg_0f1e2d3c';
export const ev = {
  runStarted: (text: string): ScriptStep => ({event: 'run.started', data: {user_message: {role: 'user', content: text}, runtime: {}}}),
  messageStarted: (): ScriptStep => ({event: 'message.started', data: {message: {id: MSG, role: 'assistant'}}}),
  delta: (delta: string): ScriptStep => ({event: 'assistant.delta', data: {message_id: MSG, delta}}),
  toolStarted: (name: string, args: Record<string, unknown> = {}): ScriptStep =>
    ({event: 'tool.started', data: {message_id: MSG, tool_name: name, preview: JSON.stringify(args), args}}),
  toolProgress: (name: string): ScriptStep => ({event: 'tool.progress', data: {message_id: MSG, tool_name: name, delta: 'pensando'}}),
  toolCompleted: (name: string): ScriptStep => ({event: 'tool.completed', data: {message_id: MSG, tool_name: name, preview: '{"ok":true}', args: {}}}),
  toolFailed: (name: string, preview = 'Error: connection refused'): ScriptStep =>
    ({event: 'tool.failed', data: {message_id: MSG, tool_name: name, preview, args: {business_id: 'biz-SECRET-ARG'}}}),
  completed: (content: string, completed = true): ScriptStep =>
    ({event: 'assistant.completed', data: {message_id: MSG, content, completed, partial: false, interrupted: false, runtime: {}}}),
  runCompleted: (): ScriptStep => ({event: 'run.completed', data: {message_id: MSG, completed: true, partial: false, interrupted: false,
    messages: [], usage: {input_tokens: 10, output_tokens: 5}, runtime: {}}}),
  runFailed: (extra: Record<string, unknown> = {}): ScriptStep => ({event: 'run.failed', data: {message_id: MSG, completed: false,
    partial: false, interrupted: false, messages: [], usage: {}, runtime: {}, ...extra}}),
  runCancelled: (): ScriptStep => ({event: 'run.cancelled', data: {message_id: MSG, completed: false, interrupted: true}}),
  error: (message: string): ScriptStep => ({event: 'error', data: {message}}),
  done: (): ScriptStep => ({event: 'done', data: {}}),
};
