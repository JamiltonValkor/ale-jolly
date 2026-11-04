import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {AppModule, type AppDependencies} from '../src/app.module';
import {ChatRepository} from '../src/chat/chat-repository';
import {ChatService, MAIN_SESSION_ID, ROBOT_VOICE_INSTRUCTIONS, type ChatDeps} from '../src/chat/chat.service';
import {ErrorResponseV1, PairingPollResponseV1, PairingStartResponseV1} from '../src/contracts/v1';
import {DevicesRepository} from '../src/devices/devices-repository';
import {DevicesService} from '../src/devices/devices.service';
import {HttpHermesClient} from '../src/hermes/hermes-client';
import {configureApp} from '../src/http/configure-app';
import {outboundFetch} from '../src/outbound/http-client';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {buildStock, stockSettings, type StockRuntime} from '../src/stock/module';
import {STOCK_VOICE_RULE} from '../src/stock/notices';
import {API_SERVER_KEY, FakeInstances, seedAssistant} from './support/hermes-fakes';
import {ev, FakeHermesServer} from './support/hermes-sse-server';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {pgliteStockDb} from './support/stock-world';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const cipher = new FieldCipher(Buffer.alloc(32, 11));
const BUSINESS = '7e88bd4a-0000-4000-8000-0000000000c1';
const STRANGER = 'stranger-robot';
const SIGNED = 'https://storage.googleapis.com/fake?X-Goog-Signature=SECRETO';

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

const until = async (check: () => boolean | Promise<boolean>, ms = 3_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('no ocurrió a tiempo');
};

describe('canal robot de Stock', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let token: string;
  let strangerToken: string;
  let app: INestApplication;
  let base: string;
  let hermes: FakeHermesServer;
  let logger: CaptureLogger;
  let stock: StockRuntime;
  let chat: ChatService;
  let now: {value: Date};
  const open: AbortController[] = [];

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    [token, strangerToken] = await Promise.all([keys.sign({sub: USER_ID, exp}), keys.sign({sub: STRANGER, exp})]);
  });
  afterAll(async () => {await db.close();});

  const boot = async (options: {stock?: boolean; bench?: boolean; supplier?: boolean; waitMs?: number; users?: string[]; wake?: boolean; deviceContext?: ChatDeps['deviceContext']; stockContext?: ChatDeps['stockTurnContext']; heartbeatMs?: number; onReady?: () => undefined} = {}) => {
    now = {value: new Date()};
    const instances = new FakeInstances();
    instances.setStatus('TERMINATED');
    chat = new ChatService({requestTimeoutMs: 2_000, upstreamIdleMs: 1_500}, {
      repository: new AssistantRepository(db.database), sessions: new ChatRepository(db.database),
      hermes: new HttpHermesClient(outboundFetch({userAgent: 't', timeoutMs: 5_000}), hermes.port, outboundFetch({userAgent: 't', timeoutMs: 60_000})),
      cipher, mcpFailures: {reportMcpToolFailure: async () => undefined}, instances, deviceContext: options.deviceContext,
      stockTurnContext: options.stockContext ?? (userId => stock.notices.voiceContext(userId)),
    });
    const devices = new DevicesService({pairingTtlMs: 600_000, maxPending: 3, claimAttempts: 3, claimWindowMs: 600_000,
      claimUrl: 'https://app.example.test/v', now: () => now.value}, new DevicesRepository(db.database));
    const users = options.users ?? [USER_ID];
    const settings = stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: users, STOCK_BUSINESS_SEEDS: users.includes(USER_ID) ? [`${BUSINESS}:${USER_ID}:COP`] : [],
      STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: options.bench ?? false, STOCK_MAX_AUTONOMY_LEVEL: 2,
      ...(options.supplier ? {STOCK_SUPPLIER_CHANNEL: 'banco' as const, STOCK_SUPPLIER_DESTINATION: 'destino-banco'} : {})});
    const built = options.stock === false ? undefined : await buildStock(settings, {
      pool: db.database.pool, db: pgliteStockDb(db), now: () => now.value, assertOwned: async () => undefined,
      offerings: {find: async (_u, _b, ref) => ({...ref, name: 'Oferta'})}, heartbeatMs: options.heartbeatMs ?? 30, toolWaitMs: options.waitMs ?? 800,
      photoStore: {signPut: async () => SIGNED, signGet: async () => SIGNED},
      ...(options.wake ? {wake: async () => 'solicitado' as const} : {}),
      ...(options.onReady ? {sync: {intervalMs: 300_000, onReady: options.onReady, repository: new AssistantRepository(db.database)}} : {}),
    });
    stock = built!;
    const deps: AppDependencies = {
      database: db.database, identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)}, cipher, chat, chatHeartbeatMs: 30, devices, ...(built ? {stock: built} : {}),
    };
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register(deps)]}).compile();
    logger = new CaptureLogger();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  };

  beforeEach(async () => {
    await db.database.pool.query(`TRUNCATE assistant.assistants, assistant.assistant_events, assistant.robot_pairings, assistant.robot_devices,
      assistant.stock_robot_events, assistant.stock_device_presence, assistant.stock_enabled_businesses CASCADE`, []);
    await db.database.pool.query('TRUNCATE assistant.stock_photos, assistant.stock_owner_utterances, assistant.stock_runs, assistant.stock_usage CASCADE', []);
    hermes = new FakeHermesServer(API_SERVER_KEY);
    await hermes.start();
    await seedAssistant(db.database, cipher, {
      userId: USER_ID, status: 'ready', step: null, privateIp: '127.0.0.1', startedAt: new Date(Date.now() - 600_000),
      aiConfigured: true, provider: 'openrouter', model: 'openai/gpt-4o-mini', readySince: new Date(),
    });
    await db.database.pool.query('UPDATE assistant.assistants SET session_id = $2 WHERE user_id = $1', [USER_ID, MAIN_SESSION_ID]);
    hermes.sessions.add(MAIN_SESSION_ID);
  });
  afterEach(async () => {
    open.splice(0).forEach(client => client.abort());
    await new Promise(resolve => setTimeout(resolve, 20));
    await app.close();
    await hermes.stop();
  });

  const post = (path: string, body: unknown, bearer?: string) => fetch(`${base}${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...(bearer ? {authorization: `Bearer ${bearer}`} : {})}});
  const pair = async (bearer = token) => {
    const started = PairingStartResponseV1.parse(await (await post('/devices/pairing', {name: 'Jolly'})).json());
    expect((await post('/assistants/me/devices/claim', {code: started.code}, bearer)).status).toBe(200);
    const polled = PairingPollResponseV1.parse(await (await post(`/devices/pairing/${started.pairing_id}/poll`, {poll_secret: started.poll_secret})).json());
    if (polled.status !== 'paired') throw new Error('not paired');
    return polled;
  };
  const op = (device: string, body: unknown) => post('/devices/me/stream', body, device);
  const opJson = async (device: string, body: unknown) => {
    const response = await op(device, body);
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const code = async (response: Response) => ErrorResponseV1.parse(await response.json()).code;

  /** Abre `op:events` y va acumulando el texto. */
  const connect = async (device: string, after = 0) => {
    const client = new AbortController();
    open.push(client);
    const response = await fetch(`${base}/devices/me/stream`, {method: 'POST', signal: client.signal,
      body: JSON.stringify({op: 'events', after, device_state: 'activo'}), headers: {'content-type': 'application/json', authorization: `Bearer ${device}`}});
    const state = {text: '', closed: false, status: response.status, client,
      events: () => state.text.split('\n\n').filter(block => block.startsWith('event: stock')).map(block => JSON.parse(block.split('\n')[2]!.slice(6)) as {id: number; kind: string; payload: Record<string, unknown>})};
    const reader = response.body!.getReader();
    void (async () => {
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          state.text += Buffer.from(value).toString();
        }
      } catch {/* cortada por la prueba */}
      state.closed = true;
    })();
    return state;
  };
  const events = (status?: string) => db.database.pool.query(`SELECT id, kind, status, payload FROM assistant.stock_robot_events ${status ? 'WHERE status = $1' : ''} ORDER BY id`, status ? [status] : [])
    .then(result => result.rows as Array<{id: string; kind: string; status: string; payload: {solicitud_id: string}}>);
  const take = (concepto = 'jar', photo_id?: string) => stock.photos.take(USER_ID, BUSINESS, {idempotency_key: randomUUID(), concepto, etiqueta: 'frascos', ...(photo_id ? {photo_id} : {})});
  const sam = (total: number) => ({concepto: 'jar', total, ms: 10, objetos: Array.from({length: total}, (_, index) => ({n: index + 1, caja: [1, 2, 3, 4] as [number, number, number, number], confianza: 0.9}))});
  const SHA = 'a'.repeat(64);
  const finish = async (device: string, requestId: string, total = 3) => {
    await opJson(device, {op: 'photo_url', request_id: requestId, role: 'original', content_type: 'image/jpeg'});
    await opJson(device, {op: 'photo_url', request_id: requestId, role: 'numerada', content_type: 'image/jpeg'});
    return opJson(device, {op: 'photo_done', request_id: requestId, sam: sam(total), tiempos: {sam: 1}, fuente: 'simulada', imagen_sha256: SHA});
  };

  it('con bandera apagada o usuario fuera, un cuerpo con op se rechaza igual que hoy y no toca Stock', async () => {
    await boot({stock: false});
    let robot = await pair();
    const off = await op(robot.device_token, {op: 'events', after: 0, device_state: 'activo'});
    expect([off.status, await code(off)]).toEqual([400, 'INVALID_REQUEST']);
    expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', [])).rows).toEqual([]);
    await app.close();
    await boot({users: ['otro-usuario']});
    robot = await pair();
    const outside = await op(robot.device_token, {op: 'events', after: 0, device_state: 'activo'});
    expect([outside.status, await code(outside)]).toEqual([400, 'INVALID_REQUEST']);
    expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', [])).rows).toEqual([]);
  });

  it('{text, voice} sigue igual y además guarda la frase; un fallo al guardarla no impide el turno', async () => {
    await boot();
    const robot = await pair();
    const script = () => [ev.runStarted('x'), ev.delta('Listo'), ev.completed('Listo'), ev.runCompleted(), ev.done()];
    hermes.scripts.push(script());
    const first = await op(robot.device_token, {text: 'sí, son veintidós', voice: true});
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Listo');
    const stored = await db.database.pool.query('SELECT text, device_id FROM assistant.stock_owner_utterances', []);
    expect(stored.rows).toEqual([{text: 'sí, son veintidós', device_id: robot.device_id}]);
    const query = stock.db.query;
    stock.db.query = (async () => {throw new Error('base caída');}) as typeof query;
    hermes.scripts.push(script());
    const second = await op(robot.device_token, {text: 'otra', voice: true});
    stock.db.query = query;
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Listo');
  });

  it('op:events no abre turno ni corta el turno en curso; photo_done tampoco', async () => {
    await boot();
    const robot = await pair();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    hermes.scripts.push([ev.runStarted('x'), ev.delta('Déjame '), {wait: gate}, ev.delta('contar'), ev.completed('Déjame contar'), ev.runCompleted(), ev.done()]);
    const turn = op(robot.device_token, {text: 'cuenta', voice: true});
    const active = (chat as unknown as {active: Map<string, AbortController>}).active;
    await until(() => active.size === 1 && hermes.streamRequests.length > 0);
    await new Promise(resolve => setTimeout(resolve, 100)); // El turno ya llegó a Hermes: desde aquí nada debe sumar.
    const controller = [...active.values()][0]!;
    const before = hermes.streamRequests.length;
    await connect(robot.device_token);
    await until(() => db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', []).then(r => r.rows.length === 1));
    const photo = take();
    await until(async () => (await events('entregado')).length === 1);
    await finish(robot.device_token, (await events())[0]!.payload.solicitud_id);
    expect((await photo).status).toBe('ok');
    expect(hermes.streamRequests.length).toBe(before);
    expect([...active.values()][0]).toBe(controller);
    expect(controller.signal.aborted).toBe(false);
    release();
    expect(await (await turn).text()).toContain('contar');
  });

  it('una sola conexión por usuario: la nueva cierra la vieja, también con dos robots', async () => {
    await boot();
    const [one, two] = [await pair(), await pair()];
    const first = await connect(one.device_token);
    await until(() => first.text.includes('keepalive'));
    const second = await connect(two.device_token);
    await until(() => first.closed);
    expect(second.closed).toBe(false);
    void take();
    await until(() => second.events().length === 1);
    expect(first.events()).toEqual([]);
  });

  it('reconectar con after entrega lo pendiente sin repetir lo confirmado', async () => {
    await boot();
    const robot = await pair();
    const first = await connect(robot.device_token);
    void take();
    void take('lid');
    await until(() => first.events().length === 2);
    const [one, two] = first.events();
    expect(first.text).toContain(`event: stock\nid: ${one!.id}\n`);
    expect(one!.payload).toMatchObject({concepto: 'jar', etiqueta: 'frascos', foto_id: null});
    await opJson(robot.device_token, {op: 'event_ack', event_id: one!.id, estado: 'recibido'});
    first.client.abort();
    const second = await connect(robot.device_token, one!.id);
    await until(() => second.events().length >= 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(second.events().map(event => event.id)).toEqual([two!.id]);
  });

  it('lo que el cursor ya cubre no se repite, aunque el servidor no viera su ack', async () => {
    await boot();
    const robot = await pair();
    const first = await connect(robot.device_token);
    void take();
    await until(() => first.events().length === 1);
    const [one] = first.events();
    first.client.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    const covered = await connect(robot.device_token, one!.id);
    await until(() => covered.text.includes('keepalive'));
    expect(covered.events()).toEqual([]);
    covered.client.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    const behind = await connect(robot.device_token, 0);
    await until(() => behind.events().length === 1); // Par: sin cursor, lo sin ack sí vuelve.
  });

  it('una foto sin ack en 60 s se reentrega una sola vez, con el mismo id', async () => {
    await boot();
    const robot = await pair();
    const sse = await connect(robot.device_token);
    void take();
    await until(() => sse.events().length === 1);
    now.value = new Date(now.value.getTime() + 59_000);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(sse.events().length).toBe(1);
    now.value = new Date(now.value.getTime() + 2_000);
    await until(() => sse.events().length === 2);
    now.value = new Date(now.value.getTime() + 120_000);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(sse.events().map(event => event.id)).toEqual([sse.events()[0]!.id, sse.events()[0]!.id]);
  });

  it('con ack no hay reentrega', async () => {
    await boot();
    const robot = await pair();
    const sse = await connect(robot.device_token);
    void take();
    await until(() => sse.events().length === 1);
    await opJson(robot.device_token, {op: 'event_ack', event_id: sse.events()[0]!.id, estado: 'recibido'});
    now.value = new Date(now.value.getTime() + 61_000);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(sse.events().length).toBe(1);
  });

  it('hilo de eventos caído con voz activa: robot_offline en menos de 200 ms y sin evento', async () => {
    await boot();
    const robot = await pair();
    const sse = await connect(robot.device_token);
    await until(() => sse.text.includes('keepalive'));
    sse.client.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    hermes.scripts.push([ev.runStarted('x'), ev.delta('ok'), ev.completed('ok'), ev.runCompleted(), ev.done()]);
    now.value = new Date(now.value.getTime() + 46_000);
    await (await op(robot.device_token, {text: 'hola', voice: true})).text();
    const started = Date.now();
    expect(await take()).toEqual({status: 'robot_offline'});
    expect(Date.now() - started).toBeLessThan(200);
    expect(await events()).toEqual([]);
  });

  it('10 minutos sin eventos: los keepalive mantienen al robot en línea', async () => {
    await boot();
    const robot = await pair();
    const sse = await connect(robot.device_token);
    for (let minute = 0; minute < 20; minute += 1) {
      const seen = sse.text.length;
      now.value = new Date(now.value.getTime() + 30_000);
      await until(() => sse.text.length > seen);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    expect((await take()).status).toBe('pending');
  });

  it('op:state no prueba que el hilo de eventos viva', async () => {
    await boot();
    const robot = await pair();
    await opJson(robot.device_token, {op: 'state', device_state: 'dormido'});
    expect(await take()).toEqual({status: 'robot_offline'});
  });

  it('dormido no impide la foto', async () => {
    await boot({waitMs: 30});
    const robot = await pair();
    const client = await fetch(`${base}/devices/me/stream`, {method: 'POST', body: JSON.stringify({op: 'events', after: 0, device_state: 'dormido'}),
      headers: {'content-type': 'application/json', authorization: `Bearer ${robot.device_token}`}, signal: (() => {const c = new AbortController(); open.push(c); return c.signal;})()});
    expect(client.status).toBe(200);
    await until(() => db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', []).then(r => r.rows.length === 1));
    expect((await take()).status).toBe('pending');
  });

  it('photo_url solo sirve al dueño de la solicitud, con TTL ≤ 300 s y devuelve el content_type', async () => {
    await boot({users: [USER_ID, STRANGER]});
    const [robot, stranger] = [await pair(), await pair(strangerToken)];
    await connect(robot.device_token);
    await until(() => db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', []).then(r => r.rows.length === 1));
    void take();
    await until(async () => (await events('entregado')).length === 1);
    const requestId = (await events())[0]!.payload.solicitud_id;
    const body = {op: 'photo_url', request_id: requestId, role: 'numerada', content_type: 'image/png'};
    const ajeno = await op(stranger.device_token, body);
    expect([ajeno.status, await code(ajeno)]).toEqual([404, 'NOT_FOUND']);
    const ok = await opJson(robot.device_token, body);
    expect(ok).toMatchObject({url: SIGNED, content_type: 'image/png'});
    expect(ok.expires_in as number).toBeLessThanOrEqual(300);
  });

  it('la URL firmada no llega a logs ni a stock_audit', async () => {
    await boot();
    const robot = await pair();
    await connect(robot.device_token);
    await until(() => db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', []).then(r => r.rows.length === 1));
    const photo = take();
    await until(async () => (await events('entregado')).length === 1);
    await finish(robot.device_token, (await events())[0]!.payload.solicitud_id);
    const result = await photo;
    expect(result).toMatchObject({status: 'ok', image_url: SIGNED}); // Par positivo: la URL existió.
    expect(logger.lines.join('\n')).not.toContain('SECRETO');
    const audit = await db.database.pool.query('SELECT * FROM assistant.stock_audit WHERE trace_id = $1', [(result as {photo_id: string}).photo_id]);
    expect(audit.rows.length).toBe(2);
    expect(JSON.stringify(audit.rows)).not.toContain('SECRETO');
    const stored = await db.database.pool.query('SELECT * FROM assistant.stock_photos', []);
    expect(JSON.stringify(stored.rows)).not.toContain('SECRETO');
  });

  describe('avisos', () => {
    const NOON = '2026-10-31T14:52:52.000Z';
    const question = {texto: '¿Te llegaron 22 o 24?', pregunta: true, proposal_id: null, producto_id: null, prioridad: 'normal' as const, dedupe_key: 'causa-1'};
    const heard = async (device: string) => {
      const stream = await connect(device);
      await until(async () => (await db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', [])).rows.length > 0);
      expect((await stock.notices.say(USER_ID, BUSINESS, question)).status).toBe('en_cola');
      await until(() => stream.events().some(event => event.kind === 'decir'));
      return stream;
    };
    const turn = async (device: string, text: string) => {
      hermes.scripts.push([ev.runStarted('x'), ev.delta('Anotado'), ev.completed('Anotado'), ev.runCompleted(), ev.done()]);
      const response = await post('/devices/me/stream', {text, voice: true}, device);
      expect(response.status).toBe(200);
      await response.text();
      return (hermes.streamRequests.at(-1)!.body as {instructions: string}).instructions;
    };

    it('llega por op:events con su plazo, una vez, y el ack lo cierra', async () => {
      await boot();
      now.value = new Date(NOON);
      const robot = await pair();
      const stream = await heard(robot.device_token);
      const [event] = stream.events().filter(item => item.kind === 'decir');
      expect(event!.payload).toEqual({texto: question.texto, pregunta: true, prioridad: 'normal', proposal_id: null, vence_s: 21_600});
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(stream.events().filter(item => item.kind === 'decir')).toHaveLength(1);
      await opJson(robot.device_token, {op: 'event_ack', event_id: event!.id, estado: 'hecho'});
      expect((await events('hecho'))).toHaveLength(1);
    });

    it('vencido en el robot pasa al canal', async () => {
      await boot();
      now.value = new Date(NOON);
      const robot = await pair();
      const [event] = (await heard(robot.device_token)).events().filter(item => item.kind === 'decir');
      await opJson(robot.device_token, {op: 'event_ack', event_id: event!.id, estado: 'vencido'});
      expect(await events('para_canal')).toHaveLength(1);
      expect((await stock.notices.takeForChannel(BUSINESS))?.cantidad).toBe(1);
    });

    it('dormir por op:state sobrevive al latido, y despertar entrega lo retenido al momento', async () => {
      await boot();
      now.value = new Date(NOON);
      const robot = await pair();
      const stream = await connect(robot.device_token);
      await until(async () => (await db.database.pool.query('SELECT 1 FROM assistant.stock_device_presence', [])).rows.length > 0);
      await opJson(robot.device_token, {op: 'state', device_state: 'dormido'});
      await new Promise(resolve => setTimeout(resolve, 150));   // varios latidos de 30 ms
      expect((await db.database.pool.query('SELECT device_state FROM assistant.stock_device_presence', [])).rows).toEqual([{device_state: 'dormido'}]);
      expect((await stock.notices.say(USER_ID, BUSINESS, question)).status).toBe('en_cola');
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(stream.events()).toEqual([]);
      await opJson(robot.device_token, {op: 'state', device_state: 'activo'});
      await until(() => stream.events().length === 1);
    });

    it('sin esperar al latido: el aviso sale al crearlo, y lo retenido al despertar', async () => {
      await boot({heartbeatMs: 60_000});
      now.value = new Date(NOON);
      const robot = await pair();
      const stream = await heard(robot.device_token);
      expect(stream.events()).toHaveLength(1);
      await opJson(robot.device_token, {op: 'state', device_state: 'dormido'});
      expect((await stock.notices.say(USER_ID, BUSINESS, {...question, dedupe_key: 'causa-2'})).status).toBe('en_cola');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(stream.events()).toHaveLength(1);
      await opJson(robot.device_token, {op: 'state', device_state: 'activo'});
      await until(() => stream.events().length === 2);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect((await stock.notices.say(USER_ID, BUSINESS, {...question, dedupe_key: 'causa-3'})).status).toBe('en_cola');
      await until(() => stream.events().length === 3);
    });

    it.each([
      ['con negocio', async () => ({session_id: 'saleads-flow-1', instructions: 'SALEADS_CONTINUOUS_CONTEXT_V1'}), 'SALEADS_CONTINUOUS_CONTEXT_V1\n'],
      ['sin negocio', async () => null, ''],
    ])('R6 %s: el turno «22» recibe la pregunta previa una vez, y el siguiente queda igual a hoy', async (_name, deviceContext, prefix) => {
      await boot({deviceContext});
      now.value = new Date(NOON);
      hermes.sessions.add('saleads-flow-1');
      const robot = await pair();
      const [event] = (await heard(robot.device_token)).events().filter(item => item.kind === 'decir');
      await opJson(robot.device_token, {op: 'event_ack', event_id: event!.id, estado: 'hecho'});
      const instructions = await turn(robot.device_token, 'llegaron 22');
      expect(instructions.startsWith(`${prefix}${ROBOT_VOICE_INSTRUCTIONS}\n${STOCK_VOICE_RULE}\nSTOCK_NOTICE_CONTEXT_V1`)).toBe(true);
      expect(instructions).toContain('¿Te llegaron 22 o 24?');
      // El aviso entra una vez; la regla de voz de Stock va en todo turno de un usuario de Stock (IVB-023).
      expect(await turn(robot.device_token, 'y qué más')).toBe(`${prefix}${ROBOT_VOICE_INSTRUCTIONS}\n${STOCK_VOICE_RULE}`);
    });

    it('primera sesión de un flujo nacida por voz: título único aunque `SaleADS` ya exista (IVB-023)', async () => {
      await boot({deviceContext: async () => ({session_id: 'saleads-flow-f4ef3532-9587', instructions: 'SALEADS_CONTINUOUS_CONTEXT_V1', business_id: BUSINESS}) as never});
      hermes.uniqueTitles = true;
      hermes.titles.set('SaleADS', 'saleads-main');
      hermes.sessions.add('saleads-main');
      const robot = await pair();
      await turn(robot.device_token, 'hola');
      expect(hermes.sessions.has('saleads-flow-f4ef3532-9587')).toBe(true);
      expect((hermes.sessionPosts.at(-1)!.body as {title: string}).title).toBe(`SaleADS ${BUSINESS.slice(0, 8)} f4ef3532`);
    });

    it('si Hermes rechaza la sesión, el robot recibe SERVICE_UNAVAILABLE, no ASSISTANT_RESTARTING (IVB-023)', async () => {
      await boot({deviceContext: async () => ({session_id: 'saleads-flow-otra-1', instructions: 'SALEADS_CONTINUOUS_CONTEXT_V1', business_id: BUSINESS}) as never});
      hermes.uniqueTitles = true;
      for (const title of [`SaleADS ${BUSINESS.slice(0, 8)} otra-1`, `SaleADS ${BUSINESS.slice(0, 8)} otra-1 a-otra-1`]) hermes.titles.set(title, 'ocupada');
      hermes.titles.set(`SaleADS ${BUSINESS.slice(0, 8)} otra-1 ${'saleads-flow-otra-1'.slice(-8)}`, 'ocupada');
      const robot = await pair();
      const response = await post('/devices/me/stream', {text: 'hola', voice: true}, robot.device_token);
      expect(response.status).toBe(503);
      expect(await code(response)).toBe('SERVICE_UNAVAILABLE');
    });

    it('un fallo de Stock no impide el turno de voz', async () => {
      await boot({stockContext: async () => {throw new Error('caída');}});
      const robot = await pair();
      expect(await turn(robot.device_token, 'hola')).toBe(ROBOT_VOICE_INSTRUCTIONS);
    });

    it('usuario fuera de Stock: instrucciones iguales a hoy', async () => {
      await boot({users: ['otro-usuario']});
      const robot = await pair();
      expect(await turn(robot.device_token, 'hola')).toBe(ROBOT_VOICE_INSTRUCTIONS);
    });
  });

  describe('banco', () => {
    const RUN = '7e88bd4a-0000-4000-8000-0000000000d1';
    const semilla = (extra = {}) => ({negocio_id: BUSINESS, nombre: 'Corrida', semilla: '42', ...extra});
    const catalog = (name: string) => ({idempotency_key: randomUUID(), kind: 'catalogo', detalle: {producto: name, variantes: [{nombre: '250 ml'}], oferta: {type: 'product', id: 'o-1'}}});

    it('sin STOCK_BENCH_ENABLED se rechaza como cuerpo inválido', async () => {
      await boot();
      const robot = await pair();
      for (const body of [{op: 'bench_clock', offset_seconds: 10, run_id: RUN}, {op: 'bench_tick', run_id: RUN}, {op: 'bench_state', run_id: RUN},
        {op: 'bench_seed', semilla: semilla(), run_id: RUN, lote: 0, ultimo: true}, {op: 'bench_campaign', proposal_id: RUN, senales: {}, run_id: RUN}]) {
        const response = await op(robot.device_token, body);
        expect([response.status, await code(response)]).toEqual([400, 'INVALID_REQUEST']);
      }
      expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_runs', [])).rows).toEqual([]);
    });

    it('con bandera y usuario fuera de STOCK_USER_IDS se rechaza igual', async () => {
      await boot({bench: true, users: ['otro-usuario']});
      const robot = await pair();
      const response = await op(robot.device_token, {op: 'bench_tick', run_id: RUN});
      expect([response.status, await code(response)]).toEqual([400, 'INVALID_REQUEST']);
    });

    it('abrir op:events pide sincronizar al usuario, sin esperar el temporizador', async () => {
      const onReady = jest.fn(() => undefined);
      await boot({onReady});
      const robot = await pair();
      await connect(robot.device_token);
      await stock.syncDriver!.stop();
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onReady).toHaveBeenCalledWith(USER_ID, expect.any(String), expect.anything());
    });

    it('bench_tick sin run activo se rechaza; con run usa wake', async () => {
      await boot({bench: true, wake: true});
      const robot = await pair();
      const refused = await op(robot.device_token, {op: 'bench_tick', run_id: RUN});
      expect([refused.status, await code(refused)]).toEqual([409, 'CONFLICT']);
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla(), run_id: RUN, lote: 0, ultimo: true});
      expect(await opJson(robot.device_token, {op: 'bench_tick', run_id: RUN})).toEqual({status: 'solicitado'});
      await db.database.pool.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = $1`, [RUN]);
      const closed = await op(robot.device_token, {op: 'bench_tick', run_id: RUN});
      expect([closed.status, await code(closed)]).toEqual([409, 'CONFLICT']);
    });

    it('sin VM alcanzable bench_tick responde no_disponible', async () => {
      await boot({bench: true});
      const robot = await pair();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla(), run_id: RUN, lote: 0, ultimo: true});
      expect(await opJson(robot.device_token, {op: 'bench_tick', run_id: RUN})).toEqual({status: 'no_disponible'});
    });

    /** Corrida propia: lo que dejan estas pruebas no debe caer en la corrida compartida del resto. */
    let paused: string[] = [];
    const ownRun = async () => {
      const {rows} = await db.database.pool.query<{id: string}>(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE business_id = $1 AND status = 'activo' RETURNING id`, [BUSINESS]);
      paused = rows.map(row => row.id);
      return randomUUID();
    };
    afterEach(async () => {
      if (!paused.length) return;
      await db.database.pool.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE business_id = $1 AND status = 'activo'`, [BUSINESS]);
      await db.database.pool.query(`UPDATE assistant.stock_runs SET status = 'activo' WHERE id = ANY($1::uuid[])`, [paused]);
      paused = [];
    });

    // IVB-024 (P8): la venta de 4 Tónicos dio STOCK_NEGATIVE, pero la venta anterior del lote quedó aplicada y la fallida
    // quedó pendiente en «Por aprobar». El lote es una sola transacción.
    it('bench_seed es atómico: si una venta da STOCK_NEGATIVE, el lote no deja ventas, propuestas, proveedores ni presupuestos', async () => {
      await boot({bench: true});
      const robot = await pair();
      const run = await ownRun();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [catalog('Tónico')]}), run_id: run, lote: 0, ultimo: false});
      const {variantes} = await opJson(robot.device_token, {op: 'bench_state', run_id: run}) as {variantes: Array<{id: string}>};
      const variante = variantes[0]!.id;
      const conteo = {idempotency_key: randomUUID(), kind: 'conteo', detalle: {variante_id: variante, contado: 5, origen: 'canal'}, causa: 'movimiento'};
      expect(await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [conteo]}), run_id: run, lote: 1, ultimo: false})).toMatchObject({aplicadas: 1});
      const venta = (cantidad: number) => ({idempotency_key: randomUUID(), kind: 'venta', detalle: {variante_id: variante, cantidad}});
      const before = await opJson(robot.device_token, {op: 'bench_state', run_id: run}) as {movimientos: number; propuestas: unknown[]};
      const proveedor = {id: randomUUID(), nombre: 'Capilar', dias_entrega: 5, cotizaciones: []};
      const failed = await op(robot.device_token, {op: 'bench_seed', run_id: run, lote: 2, ultimo: true,
        semilla: semilla({proveedores: [proveedor], presupuestos: {avisos_voz: 3}, aplicar: [venta(2), venta(4)], propuestas: [venta(1)]})});
      expect([failed.status, await code(failed)]).toEqual([409, 'STOCK_NEGATIVE']);
      const after = await opJson(robot.device_token, {op: 'bench_state', run_id: run}) as {movimientos: number; propuestas: unknown[]};
      expect(after).toMatchObject({movimientos: before.movimientos, propuestas: before.propuestas});
      const {rows: saldo} = await db.database.pool.query<{n: number}>('SELECT COALESCE(sum(delta), 0)::int AS n FROM assistant.stock_movements WHERE variant_id = $1', [variante]);
      expect(saldo[0]!.n).toBe(5);
      expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_suppliers WHERE id = $1', [proveedor.id])).rows).toEqual([]);
      expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_run_budgets WHERE run_id = $1', [run])).rows).toEqual([]);
      // El mismo lote sin la venta que no alcanza sí entra entero.
      expect(await opJson(robot.device_token, {op: 'bench_seed', run_id: run, lote: 2, ultimo: true, semilla: semilla({aplicar: [venta(2), venta(3)]})})).toMatchObject({aplicadas: 2});
    });

    it('proveedor simulado: la semilla trae cotización, un pedido se aprueba, y `bench_supplier_reply` hace de proveedor', async () => {
      await boot({bench: true, supplier: true});
      const robot = await pair();
      const run = await ownRun();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [catalog('Shampoo')]}), run_id: run, lote: 0, ultimo: false});
      const {variantes} = await opJson(robot.device_token, {op: 'bench_state', run_id: run}) as {variantes: Array<{id: string}>};
      const variante = variantes[0]!.id;
      const proveedor = randomUUID();
      const cotizacion = {variante_id: variante, precio: '18000', flete: '0', minimo: 1, plazo_pago_dias: 30, garantia: null, prueba_equivalencia: {lote: 'A'}, moneda: 'COP'};
      const pedido = {idempotency_key: randomUUID(), kind: 'pedido', detalle: {variante_id: variante, proveedor_id: proveedor, cantidad: 10, mandato: {precio_objetivo: '16000', tope: '18000'}}};
      const seeded = [{id: proveedor, nombre: 'Capilar', dias_entrega: 5, cotizaciones: [cotizacion]}];
      expect(await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({proveedores: seeded, aplicar: [pedido]}), run_id: run, lote: 1, ultimo: true})).toMatchObject({aplicadas: 1});
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({proveedores: seeded}), run_id: run, lote: 2, ultimo: true});
      const {proveedores} = await stock.reads.suppliers(BUSINESS, variante);
      expect(proveedores).toEqual([expect.objectContaining({simulado: true, cotizaciones: [expect.objectContaining({precio: '18000.00', equivalencia: 'equivalente'})]})]);
      const {pedidos} = await stock.reads.orders(BUSINESS);
      expect(pedidos[0]).toMatchObject({estado: 'negociando', simulado: true});
      expect(await opJson(robot.device_token, {op: 'bench_supplier_reply', texto: 'Lo dejo en 17.500', run_id: run})).toEqual({ok: true, simulado: true});
      await stock.negotiation.tick();
      expect(await stock.negotiation.wait(BUSINESS, {order_id: pedidos[0]!.id})).toMatchObject({status: 'respuesta', precio_proveedor: '17500.00'});
    });

    it('IVB-024 (1.0.4): la semilla fija el costo de una variante de la corrida, y una ajena da 409', async () => {
      await boot({bench: true});
      const robot = await pair();
      const run = await ownRun();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [catalog('Sérum')]}), run_id: run, lote: 0, ultimo: false});
      const {variantes} = await opJson(robot.device_token, {op: 'bench_state', run_id: run}) as {variantes: Array<{id: string}>};
      const variante = variantes[0]!.id;
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({costos: [{variante_id: variante, costo_unitario: '19000', moneda: 'COP'}]}), run_id: run, lote: 1, ultimo: false});
      const signal = await stock.rotation.signal(USER_ID, BUSINESS, variante);
      expect(signal.costo).toEqual({unitario: '19000.00', moneda: 'COP', fuente: 'factura'});
      const ajena = await op(robot.device_token, {op: 'bench_seed', semilla: semilla({costos: [{variante_id: randomUUID(), costo_unitario: '1', moneda: 'COP'}]}), run_id: run, lote: 2, ultimo: true});
      expect(ajena.status).toBe(409);
    });

    it('`bench_supplier_reply` sin adaptador de banco responde 503, y sin run activo se rechaza', async () => {
      await boot({bench: true});
      const robot = await pair();
      const run = await ownRun();
      expect((await op(robot.device_token, {op: 'bench_supplier_reply', texto: 'x', run_id: run})).status).toBe(409);
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla(), run_id: run, lote: 0, ultimo: true});
      expect((await op(robot.device_token, {op: 'bench_supplier_reply', texto: 'x', run_id: run})).status).toBe(503);
    });

    it('bench_seed aplica por las reglas reales con método semilla, deja propuestas simuladas y es idempotente', async () => {
      await boot({bench: true});
      const robot = await pair();
      const applied = catalog('Mascarilla');
      const pending = catalog('Champú');
      const body = {op: 'bench_seed', semilla: semilla({aplicar: [applied], propuestas: [pending], presupuestos: {sam: 5}}), run_id: RUN, lote: 0, ultimo: true};
      expect(await opJson(robot.device_token, body)).toMatchObject({aplicadas: 1, pendientes: 1});
      expect(await opJson(robot.device_token, body)).toMatchObject({aplicadas: 0, pendientes: 1});
      const state = await opJson(robot.device_token, {op: 'bench_state', run_id: RUN}) as {propuestas: Array<{status: string}>; variantes: Array<{producto: string}>};
      expect(state.propuestas.map(row => row.status).sort()).toEqual(['aprobada', 'pendiente']);
      expect(state.variantes.map(row => row.producto)).toEqual(['Mascarilla']);
      const confirmed = await db.database.pool.query(`SELECT method, simulated FROM assistant.stock_confirmations WHERE run_id = $1`, [RUN]);
      expect(confirmed.rows).toEqual([{method: 'semilla', simulated: true}]);
    });

    it('una historia de 8 semanas de 3 productos entra en lotes bajo 131 KB', async () => {
      await boot({bench: true});
      const robot = await pair();
      const items = Array.from({length: 3 * 56 * 6}, () => ({idempotency_key: randomUUID(), kind: 'venta', detalle: {variante_id: randomUUID(), cantidad: 2}}));
      const size = 250;
      for (let lote = 0; lote * size < items.length; lote += 1) {
        const body = JSON.stringify({op: 'bench_seed', semilla: semilla({propuestas: [], aplicar: items.slice(lote * size, (lote + 1) * size)}), run_id: RUN, lote, ultimo: false});
        expect(Buffer.byteLength(body)).toBeLessThan(131_072);
      }
      const oversized = await op(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: items.slice(0, 501)}), run_id: RUN, lote: 0, ultimo: false});
      expect(oversized.status).toBe(400); // Par negativo: un lote de más no entra ni por tamaño ni por esquema.
    });

    it('bench_clock mueve el reloj del negocio y deja el salto; bench_state da la traza por movimiento', async () => {
      await boot({bench: true});
      const robot = await pair();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [catalog('Crema')]}), run_id: RUN, lote: 0, ultimo: true});
      const before = await stock.clock.at(BUSINESS);
      await opJson(robot.device_token, {op: 'bench_clock', offset_seconds: 7 * 86_400, run_id: RUN});
      expect((await stock.clock.at(BUSINESS)).getTime() - before.getTime()).toBe(7 * 86_400_000);
      expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_clock_jumps WHERE run_id = $1', [RUN])).rows.length).toBe(1);
      const {variantes} = await opJson(robot.device_token, {op: 'bench_state', run_id: RUN}) as {variantes: Array<{id: string}>};
      const count = {idempotency_key: randomUUID(), kind: 'conteo', detalle: {variante_id: variantes[0]!.id, contado: 5, origen: 'voz'}, causa: 'otra'};
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [count]}), run_id: RUN, lote: 1, ultimo: true});
      const moved = await db.database.pool.query(`SELECT id FROM assistant.stock_movements WHERE run_id = $1`, [RUN]);
      const movement = (moved.rows[0] as {id: string}).id;
      const state = await opJson(robot.device_token, {op: 'bench_state', run_id: RUN, movement_id: movement}) as {trace: unknown[]};
      expect(state.trace.length).toBeGreaterThan(0);
      await db.database.pool.query(`DELETE FROM assistant.stock_clock_offsets WHERE business_id = $1`, [BUSINESS]);
    });

    it('bench_close cierra la corrida, libera el negocio para otra y devuelve el reloj a la hora real', async () => {
      await boot({bench: true});
      const robot = await pair();
      const first = await ownRun();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla({aplicar: [catalog('Tinte')]}), run_id: first, lote: 0, ultimo: true});
      await opJson(robot.device_token, {op: 'bench_clock', offset_seconds: 30 * 86_400, run_id: first});
      // Un aviso de esta corrida sin decir y otro sin corrida (uso real): solo el primero muere con el cierre.
      const pending = (key: string) => db.database.pool.query<{id: string}>(
        `INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,dedupe_key,dedupe_day) VALUES ($1,$2,'decir','{}',$3,'2026-11-01') RETURNING id`,
        [BUSINESS, USER_ID, key]).then(r => r.rows[0]!.id);
      const ofRun = await pending(`alerta:abc@corrida-${first}`);
      const real = await pending('alerta:abc');
      const second = randomUUID();
      // Con la primera viva, otra corrida del mismo negocio choca con el índice único de activa.
      expect((await op(robot.device_token, {op: 'bench_seed', semilla: semilla(), run_id: second, lote: 0, ultimo: true})).status).toBeGreaterThanOrEqual(409);
      expect(await opJson(robot.device_token, {op: 'bench_close', run_id: first})).toMatchObject({ok: true, run_id: first, estado: 'cerrado', avisos_descartados: 1});
      const status = async (id: string) => (await db.database.pool.query<{status: string}>('SELECT status FROM assistant.stock_robot_events WHERE id = $1', [id])).rows[0]!.status;
      expect([await status(ofRun), await status(real)]).toEqual(['descartado', 'pendiente']);
      expect(Math.abs((await stock.clock.at(BUSINESS)).getTime() - now.value.getTime())).toBeLessThan(1_000);
      const {rows} = await db.database.pool.query<{status: string}>('SELECT status FROM assistant.stock_runs WHERE id = $1', [first]);
      expect(rows[0]!.status).toBe('cerrado');
      expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_products WHERE run_id = $1', [first])).rows.length).toBe(1);   // R3: nada se borra
      expect((await db.database.pool.query('SELECT 1 FROM assistant.stock_clock_jumps WHERE run_id = $1', [first])).rows.length).toBe(2);
      const again = await op(robot.device_token, {op: 'bench_close', run_id: first});
      expect([again.status, await code(again)]).toEqual([409, 'CONFLICT']);
      const state = await op(robot.device_token, {op: 'bench_state', run_id: first});
      expect(state.status).toBe(409);
      expect(await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla(), run_id: second, lote: 0, ultimo: true})).toMatchObject({ok: true});
      await db.database.pool.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = $1`, [second]);
    });

    // Un `boot` por prueba: dos dejaban la primera app abierta y Jest no salía (CI cancelado por tiempo).
    it('bench_close sin bandera se rechaza como cuerpo inválido', async () => {
      await boot();
      const robot = await pair();
      const response = await op(robot.device_token, {op: 'bench_close', run_id: RUN});
      expect([response.status, await code(response)]).toEqual([400, 'INVALID_REQUEST']);
    });

    it('bench_close de una corrida que no existe o no está activa da CONFLICT', async () => {
      await boot({bench: true});
      const robot = await pair();
      const missing = await op(robot.device_token, {op: 'bench_close', run_id: randomUUID()});
      expect([missing.status, await code(missing)]).toEqual([409, 'CONFLICT']);
    });

    it('bench_campaign exige apuesta aprobada del run', async () => {
      await boot({bench: true});
      const robot = await pair();
      await opJson(robot.device_token, {op: 'bench_seed', semilla: semilla(), run_id: RUN, lote: 0, ultimo: true});
      const response = await op(robot.device_token, {op: 'bench_campaign', proposal_id: RUN, senales: {gasto: 1}, run_id: RUN});
      expect([response.status, await code(response)]).toEqual([409, 'CONFLICT']);
    });
  });
});
