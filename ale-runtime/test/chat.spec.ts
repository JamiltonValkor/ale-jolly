import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import type {AddressInfo} from 'node:net';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {classifyProviderFailure, HermesTurnNormalizer, sseFrame} from '../src/chat/chat-events';
import {ChatRepository} from '../src/chat/chat-repository';
import {ChatService, MAIN_SESSION_ID} from '../src/chat/chat.service';
import {toHistory} from '../src/chat/history';
import {ErrorResponseV1, MessagesResponseV1, SessionResponseV1, StreamEventV1, StreamRequestV1} from '../src/contracts/v1';
import {HttpHermesClient} from '../src/hermes/hermes-client';
import {configureApp} from '../src/http/configure-app';
import {outboundFetch} from '../src/outbound/http-client';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {API_SERVER_KEY, FakeInstances, seedAssistant} from './support/hermes-fakes';
import {ev, FakeHermesServer, type ScriptStep} from './support/hermes-sse-server';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const cipher = new FieldCipher(Buffer.alloc(32, 11));
const OVERVIEW = 'mcp__saleads__saleads_get_account_overview';
const SELECT = 'mcp__saleads__saleads_select_business';
const QUESTION = 'Que negocios tengo? PRIVATE-QUESTION';
const ANSWER_1 = 'Tienes 3 negocios, ';
const ANSWER_2 = 'seleccionado PRIVATE-ANSWER.';
/** Texto real de G-07 (OCB-002): key revocada en OpenRouter. */
const REJECTED_KEY = "OpenRouter rejected your API key, so the model can't be reached. Update it in Settings → Providers, or run `hermes setup` in a terminal.\nProvider said: HTTP 401";

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

interface Frame { event: string | null; data: string; comment: boolean }

/** Parser SSE del lado del cliente (igual que el front: `event:` + `data:`; `:` = comentario). */
function parseFrames(raw: string): Frame[] {
  return raw.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event: '))?.slice(7) ?? null;
    const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    return {event, data, comment: lines.every(line => line.startsWith(':'))};
  });
}

function toEvents(raw: string): StreamEventV1[] {
  return parseFrames(raw).filter(frame => !frame.comment).map(frame => {
    const data = JSON.parse(frame.data) as Record<string, unknown>;
    expect(data).not.toHaveProperty('type');
    return StreamEventV1.parse({...data, type: frame.event});
  });
}

const turn = (...middle: ScriptStep[]): ScriptStep[] => [ev.runStarted(QUESTION), ev.messageStarted(), {keepalive: true}, ...middle];

describe('normalización Hermes → v1 (OCB-011)', () => {
  const run = (...steps: ScriptStep[]) => runWith({}, ...steps);
  const runWith = (options: {voice?: boolean}, ...steps: ScriptStep[]) => {
    const normalizer = new HermesTurnNormalizer(options);
    const out: StreamEventV1[] = [];
    for (const step of steps) {
      if (!('event' in step)) continue;
      const result = normalizer.push({event: step.event, data: {...step.data, run_id: 'run_1', seq: 1}});
      out.push(...result.events);
      if (result.terminal) break;
    }
    if (!normalizer.done) out.push(...normalizer.end().events);
    return out;
  };

  it('cada evento real de Hermes tiene su equivalente v1 o se ignora', () => {
    expect(run(ev.runStarted('x'), ev.messageStarted(), ev.toolStarted(OVERVIEW), ev.toolProgress(OVERVIEW), ev.toolCompleted(OVERVIEW),
      ev.delta('Hola'), ev.delta(''), ev.completed('Hola'), ev.runCompleted(), ev.done())).toEqual([
      {type: 'tool_start', name: OVERVIEW}, {type: 'tool_end', name: OVERVIEW, ok: true}, {type: 'token', text: 'Hola'}, {type: 'message_end'},
    ]);
    expect(run({event: 'assistant.commentary', data: {text: 'x'}}, {event: 'approval.request', data: {}}, {event: 'nuevo.evento', data: {}},
      ev.completed('ok'), ev.runCompleted())).toEqual([{type: 'token', text: 'ok'}, {type: 'message_end'}]);
  });

  it('con voice: commentary sin already_streamed y un solo thinking por turno, sin el texto del razonamiento', () => {
    const steps = [ev.toolProgress('_thinking'), ev.toolProgress('_thinking'), {event: 'assistant.commentary', data: {text: 'Ya reviso tus ventas.'}},
      {event: 'assistant.commentary', data: {text: 'Hola', already_streamed: true}}, {event: 'assistant.commentary', data: {text: '  '}},
      ev.toolStarted(OVERVIEW), ev.toolProgress(OVERVIEW), ev.toolCompleted(OVERVIEW), ev.delta('Vas bien.'), ev.completed('Vas bien.'), ev.runCompleted()];
    const voice = runWith({voice: true}, ...steps);
    expect(voice).toEqual([
      {type: 'thinking'}, {type: 'commentary', text: 'Ya reviso tus ventas.'},
      {type: 'tool_start', name: OVERVIEW}, {type: 'tool_end', name: OVERVIEW, ok: true}, {type: 'token', text: 'Vas bien.'}, {type: 'message_end'},
    ]);
    expect(JSON.stringify(voice)).not.toContain('pensando');
    expect(run(...steps)).toEqual([
      {type: 'tool_start', name: OVERVIEW}, {type: 'tool_end', name: OVERVIEW, ok: true}, {type: 'token', text: 'Vas bien.'}, {type: 'message_end'},
    ]);
  });

  it('guarda `usage.input_tokens` de `run.completed`: `tokens` cuenta fragmentos, no consumo', () => {
    const normalizer = new HermesTurnNormalizer();
    expect(normalizer.summary().inputTokens).toBeNull();
    normalizer.push({event: 'run.completed', data: {usage: {input_tokens: 136000, output_tokens: 10}}});
    expect(normalizer.summary().inputTokens).toBe(136000);
  });

  it('tool.failed nativo: tool_end ok:false sin mcp_unavailable; del MCP: además mcp_unavailable y el turno sigue', () => {
    const normalizer = new HermesTurnNormalizer();
    const native = normalizer.push({event: 'tool.failed', data: {tool_name: 'terminal'}});
    expect(native).toEqual({events: [{type: 'tool_end', name: 'terminal', ok: false}], terminal: false});
    const mcp = normalizer.push({event: 'tool.failed', data: {tool_name: SELECT}});
    expect(mcp).toEqual({events: [{type: 'tool_end', name: SELECT, ok: false}, {type: 'mcp_unavailable'}], terminal: false, mcpToolFailed: SELECT});
    expect(normalizer.done).toBe(false);
  });

  it('run.failed / error / run.cancelled / corte sin final cierran el turno', () => {
    expect(run(ev.completed(REJECTED_KEY, false), ev.runFailed())).toEqual([{type: 'provider_error', reason: 'auth'}]);
    expect(run(ev.completed('I ran out of steps for this turn', false), ev.runFailed())).toEqual([{type: 'error'}]);
    expect(run(ev.completed('', false), ev.runFailed({turn_exit_reason: 'billing'}))).toEqual([{type: 'provider_error', reason: 'quota'}]);
    expect(run(ev.error('OpenRouter rate-limited every one of 3 attempts'), ev.done())).toEqual([{type: 'provider_error', reason: 'rate_limit'}]);
    expect(run(ev.error('Traceback PRIVATE'), ev.done())).toEqual([{type: 'error'}]);
    expect(run(ev.runCancelled())).toEqual([{type: 'error'}]);
    expect(run(ev.delta('a'))).toEqual([{type: 'token', text: 'a'}, {type: 'error'}]);
    expect(run(ev.delta('a'), ev.completed('a'), ev.done())).toEqual([{type: 'token', text: 'a'}, {type: 'message_end'}]);
  });

  it('clasifica auth, quota y rate_limit con los textos de Hermes y de los proveedores', () => {
    expect(classifyProviderFailure(REJECTED_KEY)).toBe('auth');
    expect(classifyProviderFailure('Anthropic rejected your sign-in, so the model can\'t be reached.')).toBe('auth');
    expect(classifyProviderFailure("the AI model service says the account's usage or credit limit is reached")).toBe('quota');
    expect(classifyProviderFailure('HTTP 429: You exceeded your current quota (insufficient_quota)')).toBe('quota');
    expect(classifyProviderFailure('HTTP 402 Payment Required')).toBe('quota');
    expect(classifyProviderFailure('OpenRouter is rate-limiting requests right now')).toBe('rate_limit');
    expect(classifyProviderFailure('HTTP 429 Too Many Requests')).toBe('rate_limit');
    expect(classifyProviderFailure('', 'auth_permanent')).toBe('auth');
    expect(classifyProviderFailure("Model 'x' isn't available on OpenRouter")).toBeNull();
  });

  it('el marco SSE lleva el tipo en event: y el resto en data:', () => {
    expect(sseFrame({type: 'tool_end', name: OVERVIEW, ok: false})).toBe(`event: tool_end\ndata: {"name":"${OVERVIEW}","ok":false}\n\n`);
    expect(sseFrame({type: 'message_end'})).toBe('event: message_end\ndata: {}\n\n');
  });

  it('el historial expone solo user/assistant con texto, sin tools', () => {
    expect(toHistory([
      {id: 1, role: 'user', content: 'hola', timestamp: 1_760_000_000.5},
      {id: 2, role: 'assistant', content: '', tool_calls: [{}]} as never,
      {id: 3, role: 'tool', content: '{"businesses":3}', tool_name: OVERVIEW} as never,
      {id: 4, role: 'assistant', content: [{type: 'text', text: 'Tienes 3'}, {type: 'image_url'}], timestamp: '2027-08-10T05:00:00Z'},
      {id: 5, role: 'system', content: 'SOUL'},
      {id: 6, role: 'assistant', content: 'compactado', display_kind: 'hidden'},
      {role: 'user', content: 'sin id', timestamp: null},
    ])).toEqual({messages: [
      {id: '1', role: 'user', text: 'hola', created_at: new Date(1_760_000_000_500).toISOString()},
      {id: '4', role: 'assistant', text: 'Tienes 3', created_at: '2027-08-10T05:00:00.000Z'},
      {id: 'm6', role: 'user', text: 'sin id', created_at: null},
    ]});
  });

  it('el cuerpo del stream exige text de 1 a 8000 caracteres y nada más', () => {
    expect(StreamRequestV1.parse({text: '  hola '})).toEqual({text: 'hola'});
    expect(() => StreamRequestV1.parse({text: '   '})).toThrow();
    expect(() => StreamRequestV1.parse({text: 'x'.repeat(8001)})).toThrow();
    expect(() => StreamRequestV1.parse({text: 'x', model: 'y'})).toThrow();
    expect(StreamRequestV1.parse({text: 'hola', voice: true})).toEqual({text: 'hola', voice: true});
    expect(() => StreamRequestV1.parse({text: 'hola', voice: 'si'})).toThrow();
  });
});

describe('proxy del chat contra un Hermes simulado (OCB-011)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let token: string;
  let app: INestApplication;
  let base: string;
  let hermes: FakeHermesServer;
  let logger: CaptureLogger;
  let reported: Array<[string, string]>;
  let invalidated: string[];
  let instances: FakeInstances;

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    token = await keys.sign({sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600});
  });
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events', []);
    hermes = new FakeHermesServer(API_SERVER_KEY);
    await hermes.start();
    reported = [];
    invalidated = [];
    // Por defecto la VM no está RUNNING: se mantienen error / SERVICE_UNAVAILABLE de OCB-011.
    // Los casos de reinicio (OCB-016) la ponen RUNNING.
    instances = new FakeInstances();
    instances.setStatus('TERMINATED');
    const fetcher = outboundFetch({userAgent: 'SaleADS-Assistant-Service/test', timeoutMs: 5_000});
    const streamFetcher = outboundFetch({userAgent: 'SaleADS-Assistant-Service/test', timeoutMs: 60_000});
    const chat = new ChatService({requestTimeoutMs: 2_000, upstreamIdleMs: 1_500}, {
      repository: new AssistantRepository(db.database),
      sessions: new ChatRepository(db.database),
      hermes: new HttpHermesClient(fetcher, hermes.port, streamFetcher),
      cipher,
      mcpFailures: {reportMcpToolFailure: async (userId, tool) => {reported.push([userId, tool]);}},
      instances,
      onStateChanged: userId => invalidated.push(userId),
    });
    logger = new CaptureLogger();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher,
      chat,
      chatHeartbeatMs: 200,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.close();
    await hermes.stop();
  });

  const seedReady = async (overrides: {status?: string; step?: string | null; sessionId?: string | null; privateIp?: string | null} = {}) => {
    await seedAssistant(db.database, cipher, {
      userId: USER_ID, status: overrides.status ?? 'ready', step: overrides.step === undefined ? null : overrides.step,
      privateIp: overrides.privateIp === undefined ? '127.0.0.1' : overrides.privateIp, startedAt: new Date(Date.now() - 600_000),
      aiConfigured: true, provider: 'openrouter', model: 'openai/gpt-4o-mini', readySince: new Date(),
    });
    if (overrides.sessionId !== null) {
      const sessionId = overrides.sessionId ?? MAIN_SESSION_ID;
      await db.database.pool.query('UPDATE assistant.assistants SET session_id = $2 WHERE user_id = $1', [USER_ID, sessionId]);
      hermes.sessions.add(sessionId);
    }
  };
  const post = (path: string, body?: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, {
    method: 'POST', signal,
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const streamTurn = async (script: ScriptStep[], text = QUESTION, extra: {voice?: boolean} = {}) => {
    hermes.scripts.push(script);
    const response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text, ...extra});
    return {response, raw: await response.text()};
  };
  const errorCode = async (response: Response) => ErrorResponseV1.parse(await response.json()).code;
  const allLogs = () => logger.lines.join('\n');

  it('POST /sessions crea la sesión determinista en Hermes, guarda el id y lo reutiliza (409 = ya existe)', async () => {
    await seedReady({sessionId: null});
    const first = await post('/assistants/me/sessions');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(SessionResponseV1.parse(await first.json())).toEqual({session_id: MAIN_SESSION_ID});
    expect(hermes.sessionPosts).toEqual([{body: {id: MAIN_SESSION_ID, title: 'SaleADS'}, authorization: `Bearer ${API_SERVER_KEY}`}]);
    const row = (await db.database.pool.query('SELECT session_id FROM assistant.assistants WHERE user_id = $1', [USER_ID])).rows[0];
    expect(row).toEqual({session_id: MAIN_SESSION_ID});
    expect(invalidated).toEqual([USER_ID]);

    const second = await post('/assistants/me/sessions');
    expect(SessionResponseV1.parse(await second.json())).toEqual({session_id: MAIN_SESSION_ID});
    expect(hermes.sessionPosts).toHaveLength(2);
    expect(invalidated).toEqual([USER_ID]);
  });

  it('solo se chatea con status=ready: 409 ASSISTANT_NOT_READY; sin asistente o sesión ajena, 404', async () => {
    let response = await post('/assistants/me/sessions');
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('NOT_FOUND');

    await seedReady({status: 'activating', step: 'configure_ai', sessionId: null});
    response = await post('/assistants/me/sessions');
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('ASSISTANT_NOT_READY');
    response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'});
    expect(response.status).toBe(409);

    await db.database.pool.query("UPDATE assistant.assistants SET status = 'ready', step = NULL, session_id = $2 WHERE user_id = $1", [USER_ID, MAIN_SESSION_ID]);
    response = await post('/assistants/me/sessions/otra-sesion/stream', {text: 'hola'});
    expect(response.status).toBe(404);
    const history = await request(app.getHttpServer()).get('/assistants/me/sessions/otra-sesion/messages')
      .set('Authorization', `Bearer ${token}`).expect(404);
    expect(ErrorResponseV1.parse(history.body).code).toBe('NOT_FOUND');
    expect(hermes.streamRequests).toHaveLength(0);
  });

  it('cuerpo inválido → 400 INVALID_REQUEST sin llamar a Hermes', async () => {
    await seedReady();
    for (const body of [{}, {text: ''}, {text: 'x'.repeat(8001)}, {text: 'hola', extra: 1}]) {
      const response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_REQUEST');
    }
    expect(hermes.streamRequests).toHaveLength(0);
  });

  it('managed inference blocks a legacy ready row before any request reaches Hermes', async () => {
    await seedReady();
    const prepareInference = jest.fn();
    const fetcher = outboundFetch({userAgent: 'SaleADS-Assistant-Service/test', timeoutMs: 2_000});
    const gated = new ChatService({requestTimeoutMs: 2_000, upstreamIdleMs: 1_500}, {
      repository: new AssistantRepository(db.database), sessions: new ChatRepository(db.database),
      hermes: new HttpHermesClient(fetcher, hermes.port, fetcher), cipher,
      mcpFailures: {reportMcpToolFailure: async () => undefined},
      inferenceReady: () => false, prepareInference,
    });
    await expect(gated.createSession(USER_ID)).rejects.toMatchObject({code: 'ASSISTANT_NOT_READY'});
    await expect(gated.history(USER_ID, MAIN_SESSION_ID)).rejects.toMatchObject({code: 'ASSISTANT_NOT_READY'});
    await expect(gated.startTurn(USER_ID, MAIN_SESSION_ID, QUESTION, new AbortController().signal))
      .rejects.toMatchObject({code: 'ASSISTANT_NOT_READY'});
    expect(prepareInference).toHaveBeenCalledTimes(3);
    expect(hermes.sessionPosts).toHaveLength(0);
    expect(hermes.streamRequests).toHaveLength(0);
  });

  it('un turno con datos del MCP: SSE v1 en orden, keepalives descartados y el texto va a Hermes como message', async () => {
    await seedReady();
    const {response, raw} = await streamTurn(turn(
      ev.toolStarted(OVERVIEW, {include: 'businesses'}), ev.toolProgress(OVERVIEW), {keepalive: true}, ev.toolCompleted(OVERVIEW),
      ev.delta(ANSWER_1), {keepalive: true}, ev.delta(ANSWER_2), ev.completed(`${ANSWER_1}${ANSWER_2}`), ev.runCompleted(), ev.done(),
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(toEvents(raw)).toEqual([
      {type: 'tool_start', name: OVERVIEW},
      {type: 'tool_end', name: OVERVIEW, ok: true},
      {type: 'token', text: ANSWER_1},
      {type: 'token', text: ANSWER_2},
      {type: 'message_end'},
    ]);
    expect(raw).not.toContain('run.started');
    expect(raw).not.toContain('seq');
    expect(hermes.streamRequests).toEqual([{sessionId: MAIN_SESSION_ID, body: {message: QUESTION}, authorization: `Bearer ${API_SERVER_KEY}`}]);
    expect(reported).toEqual([]);
  });

  it('turno con voice: Hermes recibe model_options de razonamiento corto y el SSE trae thinking y commentary', async () => {
    await seedReady();
    const {response, raw} = await streamTurn(turn(
      ev.toolProgress('_thinking'), {event: 'assistant.commentary', data: {text: 'Ya miro.'}},
      ev.delta(ANSWER_1), ev.completed(ANSWER_1), ev.runCompleted(), ev.done(),
    ), QUESTION, {voice: true});
    expect(response.status).toBe(200);
    expect(toEvents(raw)).toEqual([
      {type: 'thinking'}, {type: 'commentary', text: 'Ya miro.'}, {type: 'token', text: ANSWER_1}, {type: 'message_end'},
    ]);
    expect(hermes.streamRequests.map(r => r.body)).toEqual([{message: QUESTION, model_options: {reasoning: {effort: 'low'}}}]);
  });

  it('tool.failed nativo no emite mcp_unavailable; el del MCP sí, avisa a la renovación y el turno continúa', async () => {
    await seedReady();
    const {raw} = await streamTurn(turn(
      ev.toolStarted('terminal'), ev.toolFailed('terminal', 'command not allowed'),
      ev.toolStarted(SELECT), ev.toolFailed(SELECT),
      ev.delta('Estoy reconectando.'), ev.completed('Estoy reconectando.'), ev.runCompleted(), ev.done(),
    ));
    expect(toEvents(raw)).toEqual([
      {type: 'tool_start', name: 'terminal'},
      {type: 'tool_end', name: 'terminal', ok: false},
      {type: 'tool_start', name: SELECT},
      {type: 'tool_end', name: SELECT, ok: false},
      {type: 'mcp_unavailable'},
      {type: 'token', text: 'Estoy reconectando.'},
      {type: 'message_end'},
    ]);
    expect(raw).not.toContain('biz-SECRET-ARG');
    expect(reported).toEqual([[USER_ID, SELECT]]);

    // El MCP volvió: el turno siguiente sigue normal en la misma sesión.
    const next = await streamTurn(turn(ev.toolStarted(SELECT), ev.toolCompleted(SELECT), ev.delta('Listo'), ev.completed('Listo'), ev.runCompleted(), ev.done()));
    expect(toEvents(next.raw).at(-1)).toEqual({type: 'message_end'});
    expect(reported).toHaveLength(1);
  });

  it('key revocada (run.failed 401 real) → provider_error{auth} y nada más; cuota → quota', async () => {
    await seedReady();
    let {raw} = await streamTurn(turn(ev.completed(REJECTED_KEY, false), ev.runFailed(), ev.done()));
    expect(toEvents(raw)).toEqual([{type: 'provider_error', reason: 'auth'}]);
    expect(raw).not.toContain('OpenRouter');

    ({raw} = await streamTurn(turn(ev.completed("OpenRouter rejected the request: the account's usage or credit limit is reached", false), ev.runFailed(), ev.done())));
    expect(toEvents(raw)).toEqual([{type: 'provider_error', reason: 'quota'}]);
    ({raw} = await streamTurn(turn(ev.error('OpenRouter is rate-limiting requests right now'), ev.done())));
    expect(toEvents(raw)).toEqual([{type: 'provider_error', reason: 'rate_limit'}]);
  });

  it('Hermes se cae a mitad del turno → error; error interno → error sin el texto crudo', async () => {
    await seedReady();
    let {raw} = await streamTurn(turn(ev.delta('Hola'), {wait: new Promise(resolve => setTimeout(resolve, 200))}, {destroy: true}));
    expect(toEvents(raw)).toEqual([{type: 'token', text: 'Hola'}, {type: 'error'}]);
    ({raw} = await streamTurn(turn(ev.error('Traceback: PRIVATE-STACK'), ev.done())));
    expect(toEvents(raw)).toEqual([{type: 'error'}]);
    expect(raw).not.toContain('PRIVATE-STACK');
  });

  it('Hermes callado (sin keepalive) más que el idle → error, y el servicio manda sus keepalive mientras tanto', async () => {
    await seedReady();
    const {raw} = await streamTurn(turn(ev.delta('Hola'), {hang: true}));
    expect(toEvents(raw)).toEqual([{type: 'token', text: 'Hola'}, {type: 'error'}]);
    expect(parseFrames(raw).some(frame => frame.comment)).toBe(true);
    await hermes.clientClosed;
    expect(allLogs()).toMatch(/chat turn run_id=run_\w+ seq=\d+ outcome=error/);
  });

  it('reenvía chunk a chunk: el primer token llega antes de que Hermes termine', async () => {
    await seedReady();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    hermes.scripts.push(turn(ev.delta('Primero'), {wait: gate}, ev.delta(' segundo'), ev.completed('Primero segundo'), ev.runCompleted(), ev.done()));
    const response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: QUESTION});
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('event: token')) raw += decoder.decode((await reader.read()).value, {stream: true});
    expect(raw).toContain('"text":"Primero"');
    expect(raw).not.toContain('segundo');
    release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, {stream: true});
    }
    expect(toEvents(raw).map(event => event.type)).toEqual(['token', 'token', 'message_end']);
  });

  it('si el cliente cancela a mitad, se corta la conexión con Hermes en segundos', async () => {
    await seedReady();
    hermes.scripts.push(turn(ev.delta('Pensando'), {hang: true}));
    const client = new AbortController();
    const response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: QUESTION}, client.signal);
    const reader = response.body!.getReader();
    await reader.read();
    const cutAt = Date.now();
    client.abort();
    await hermes.clientClosed;
    expect(Date.now() - cutAt).toBeLessThan(1_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(allLogs()).toMatch(/outcome=client_closed/);
    expect(hermes.streamRequests).toHaveLength(1);
  });

  it('sesión perdida en Hermes (404 al abrir) → se recrea y se abre una vez más', async () => {
    await seedReady();
    hermes.sessions.clear();
    const {response, raw} = await streamTurn(turn(ev.delta('ok'), ev.completed('ok'), ev.runCompleted(), ev.done()));
    expect(response.status).toBe(200);
    expect(toEvents(raw).at(-1)).toEqual({type: 'message_end'});
    expect(hermes.streamRequests).toHaveLength(2);
    expect(hermes.sessionPosts).toHaveLength(1);
  });

  it('Hermes inaccesible o con 429 al abrir → 503 SERVICE_UNAVAILABLE (sin SSE)', async () => {
    await seedReady();
    hermes.streamStatus = [429];
    let response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'});
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('SERVICE_UNAVAILABLE');
    await hermes.stop();
    response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'});
    expect(response.status).toBe(503);
    response = await post('/assistants/me/sessions');
    expect(response.status).toBe(503);
  });

  describe('reinicio de Hermes con la VM RUNNING (OCB-016)', () => {
    beforeEach(() => {instances.setStatus('RUNNING');});

    it('el drain del gateway corta el stream sin run.* → assistant_restarting cierra el turno (no error)', async () => {
      await seedReady();
      const {raw} = await streamTurn(turn(ev.delta('Hola'), {wait: new Promise(resolve => setTimeout(resolve, 100))}, {destroy: true}));
      expect(toEvents(raw)).toEqual([{type: 'token', text: 'Hola'}, {type: 'assistant_restarting'}]);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(allLogs()).toMatch(/chat turn run_id=run_\w+ seq=\d+ outcome=assistant_restarting/);
    });

    it('fin del stream (o done) sin run.* ni assistant.completed → assistant_restarting', async () => {
      await seedReady();
      let {raw} = await streamTurn(turn(ev.delta('Hola')));
      expect(toEvents(raw)).toEqual([{type: 'token', text: 'Hola'}, {type: 'assistant_restarting'}]);
      ({raw} = await streamTurn(turn(ev.delta('Hola'), ev.done())));
      expect(toEvents(raw)).toEqual([{type: 'token', text: 'Hola'}, {type: 'assistant_restarting'}]);
    });

    it('Hermes callado más que el idle → assistant_restarting', async () => {
      await seedReady();
      const {raw} = await streamTurn(turn(ev.delta('Hola'), {hang: true}));
      expect(toEvents(raw)).toEqual([{type: 'token', text: 'Hola'}, {type: 'assistant_restarting'}]);
    });

    it('los finales de Hermes no cambian: message_end, provider_error y error siguen igual', async () => {
      await seedReady();
      let {raw} = await streamTurn(turn(ev.delta('ok'), ev.completed('ok'), ev.runCompleted(), ev.done()));
      expect(toEvents(raw).at(-1)).toEqual({type: 'message_end'});
      ({raw} = await streamTurn(turn(ev.completed(REJECTED_KEY, false), ev.runFailed(), ev.done())));
      expect(toEvents(raw)).toEqual([{type: 'provider_error', reason: 'auth'}]);
      ({raw} = await streamTurn(turn(ev.error('Traceback: PRIVATE-STACK'), ev.done())));
      expect(toEvents(raw)).toEqual([{type: 'error'}]);
      ({raw} = await streamTurn(turn(ev.delta('a'), ev.completed('a'), ev.done())));
      expect(toEvents(raw).at(-1)).toEqual({type: 'message_end'});
    });

    it('Hermes sin responder al abrir → 503 ASSISTANT_RESTARTING en /stream y /sessions; un 429 sigue siendo SERVICE_UNAVAILABLE', async () => {
      await seedReady();
      hermes.streamStatus = [429];
      let response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'});
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('SERVICE_UNAVAILABLE');
      await hermes.stop();
      response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'});
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('ASSISTANT_RESTARTING');
      response = await post('/assistants/me/sessions');
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('ASSISTANT_RESTARTING');
    });

    it('sin VM RUNNING (o si Compute falla) se mantienen error y SERVICE_UNAVAILABLE', async () => {
      await seedReady();
      instances.setStatus('STOPPING');
      let {raw} = await streamTurn(turn(ev.delta('Hola'), {destroy: true}));
      expect(toEvents(raw).at(-1)).toEqual({type: 'error'});
      instances.setStatus('RUNNING');
      instances.getInstance = async () => {throw new Error('compute down');};
      ({raw} = await streamTurn(turn(ev.delta('Hola'), {destroy: true})));
      expect(toEvents(raw).at(-1)).toEqual({type: 'error'});
      await hermes.stop();
      const response = await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'});
      expect(await errorCode(response)).toBe('SERVICE_UNAVAILABLE');
    });
  });

  it('el historial al recargar trae solo user/assistant con texto', async () => {
    await seedReady();
    hermes.messages = [
      {id: 11, session_id: MAIN_SESSION_ID, role: 'user', content: QUESTION, timestamp: 1_760_500_000},
      {id: 12, session_id: MAIN_SESSION_ID, role: 'assistant', content: null, tool_calls: [{function: {name: OVERVIEW}}], timestamp: 1_760_500_001},
      {id: 13, session_id: MAIN_SESSION_ID, role: 'tool', content: '{"businesses":3}', tool_name: OVERVIEW, timestamp: 1_760_500_002},
      {id: 14, session_id: MAIN_SESSION_ID, role: 'assistant', content: `${ANSWER_1}${ANSWER_2}`, timestamp: 1_760_500_003},
    ];
    const response = await request(app.getHttpServer()).get(`/assistants/me/sessions/${MAIN_SESSION_ID}/messages`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(MessagesResponseV1.parse(response.body)).toEqual({messages: [
      {id: '11', role: 'user', text: QUESTION, created_at: new Date(1_760_500_000_000).toISOString()},
      {id: '14', role: 'assistant', text: `${ANSWER_1}${ANSWER_2}`, created_at: new Date(1_760_500_003_000).toISOString()},
    ]});
  });

  it('ningún log ni evento guardado lleva texto del chat, argumentos de tools ni la API_SERVER_KEY', async () => {
    await seedReady();
    await streamTurn(turn(ev.toolStarted(SELECT, {business_id: 'biz-SECRET-ARG'}), ev.toolFailed(SELECT), ev.delta(ANSWER_1),
      ev.completed(ANSWER_1), ev.runCompleted(), ev.done()));
    await streamTurn(turn(ev.completed(REJECTED_KEY, false), ev.runFailed(), ev.done()));
    await request(app.getHttpServer()).get(`/assistants/me/sessions/${MAIN_SESSION_ID}/messages`).set('Authorization', `Bearer ${token}`);
    const logs = allLogs();
    expect(logs).toMatch(/chat turn run_id=run_\w+ seq=\d+ outcome=message_end tokens=1 tools=1 mcp_failures=1 duration_ms=\d+/);
    expect(logs).toMatch(/outcome=provider_error reason=auth/);
    const stored = JSON.stringify((await db.database.pool.query('SELECT * FROM assistant.assistant_events', [])).rows);
    for (const secret of ['PRIVATE-QUESTION', 'PRIVATE-ANSWER', 'Tienes 3', 'biz-SECRET-ARG', 'rejected your API key', API_SERVER_KEY]) {
      expect(logs).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });
});
