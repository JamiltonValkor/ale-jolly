import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import type {AddressInfo} from 'node:net';
import {AppModule, type AppDependencies} from '../src/app.module';
import {ChatRepository} from '../src/chat/chat-repository';
import {ChatService, MAIN_SESSION_ID, ROBOT_VOICE_INSTRUCTIONS, type ChatDeps} from '../src/chat/chat.service';
import {ErrorResponseV1, PairingPollResponseV1, PairingStartResponseV1, StreamEventV1} from '../src/contracts/v1';
import {DevicesRepository} from '../src/devices/devices-repository';
import {DevicesService, normalizeCode} from '../src/devices/devices.service';
import {HttpHermesClient} from '../src/hermes/hermes-client';
import {configureApp} from '../src/http/configure-app';
import {outboundFetch} from '../src/outbound/http-client';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {API_SERVER_KEY, FakeInstances, seedAssistant} from './support/hermes-fakes';
import {ev, FakeHermesServer} from './support/hermes-sse-server';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const cipher = new FieldCipher(Buffer.alloc(32, 11));
const OTHER_USER = 'other-user-0001';

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

/** Eventos v1 de un SSE (`event:` + `data:`), sin keepalives. */
function events(raw: string): StreamEventV1[] {
  return raw.split('\n\n').filter(block => block.startsWith('event: ')).map(block => {
    const [head, data] = block.split('\n');
    return StreamEventV1.parse({...JSON.parse(data!.slice(6)) as object, type: head!.slice(7)});
  });
}

describe('canal robot: emparejamiento y turnos del robot', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let token: string;
  let otherToken: string;
  let app: INestApplication;
  let base: string;
  let hermes: FakeHermesServer;
  let logger: CaptureLogger;
  let clock: Date;

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    [token, otherToken] = await Promise.all([keys.sign({sub: USER_ID, exp}), keys.sign({sub: OTHER_USER, exp})]);
  });
  afterAll(async () => {await db.close();});

  const boot = async (withDevices: boolean, deviceContext?: ChatDeps['deviceContext']) => {
    const instances = new FakeInstances();
    instances.setStatus('TERMINATED');
    const chat = new ChatService({requestTimeoutMs: 2_000, upstreamIdleMs: 1_500}, {
      repository: new AssistantRepository(db.database), sessions: new ChatRepository(db.database),
      hermes: new HttpHermesClient(outboundFetch({userAgent: 't', timeoutMs: 5_000}), hermes.port, outboundFetch({userAgent: 't', timeoutMs: 60_000})),
      cipher, mcpFailures: {reportMcpToolFailure: async () => undefined}, instances, deviceContext,
    });
    const devices = new DevicesService({pairingTtlMs: 600_000, maxPending: 3, claimAttempts: 3, claimWindowMs: 600_000,
      claimUrl: 'https://app.example.test/ale/vincular', now: () => clock}, new DevicesRepository(db.database));
    const deps: AppDependencies = {
      database: db.database, identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)}, cipher, chat, chatHeartbeatMs: 200,
      ...(withDevices ? {devices} : {}),
    };
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register(deps)]}).compile();
    logger = new CaptureLogger();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  };

  beforeEach(async () => {
    clock = new Date('2026-10-28T12:00:00Z');
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events, assistant.robot_pairings, assistant.robot_devices', []);
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
    await app.close();
    await hermes.stop();
  });

  const post = (path: string, body: unknown, bearer?: string) => fetch(`${base}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: {'content-type': 'application/json', ...(bearer ? {authorization: `Bearer ${bearer}`} : {})},
  });
  const code = async (response: Response) => ErrorResponseV1.parse(await response.json()).code;
  /** Emparejamiento completo: devuelve la credencial del robot. */
  const pair = async (name = 'Ale de la oficina') => {
    const started = PairingStartResponseV1.parse(await (await post('/devices/pairing', {name})).json());
    expect((await post('/assistants/me/devices/claim', {code: started.code}, token)).status).toBe(200);
    const polled = PairingPollResponseV1.parse(await (await post(`/devices/pairing/${started.pairing_id}/poll`, {poll_secret: started.poll_secret})).json());
    if (polled.status !== 'paired') throw new Error('not paired');
    return polled;
  };

  it('apagado (sin ROBOT_CHANNEL_ENABLED) las rutas del robot no existen', async () => {
    await boot(false);
    expect((await post('/devices/pairing', {})).status).toBe(404);
    expect((await post('/assistants/me/devices/claim', {code: 'ABCD-EFGH'}, token)).status).toBe(404);
  });

  it('código → el dueño lo reclama → el robot recibe su credencial UNA sola vez', async () => {
    await boot(true);
    const started = PairingStartResponseV1.parse(await (await post('/devices/pairing', {name: 'Ale de la oficina'})).json());
    expect(started.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(started.claim_url).toBe(`https://app.example.test/ale/vincular?code=${started.code}`);
    const poll = (secret = started.poll_secret) => post(`/devices/pairing/${started.pairing_id}/poll`, {poll_secret: secret});

    expect(await (await poll()).json()).toEqual({status: 'pending'});
    expect((await poll('x'.repeat(43))).status).toBe(404);                       // sin el secreto no se sabe nada
    expect((await post('/devices/pairing/no-uuid/poll', {poll_secret: started.poll_secret})).status).toBe(404);

    // el dueño lo teclea como sea (minúsculas, sin guion); sin sesión web no se puede reclamar
    expect((await post('/assistants/me/devices/claim', {code: started.code})).status).toBe(401);
    const claimed = await post('/assistants/me/devices/claim', {code: started.code.toLowerCase().replace('-', ' ')}, token);
    expect(await claimed.json()).toEqual({device_name: 'Ale de la oficina'});
    expect((await post('/assistants/me/devices/claim', {code: started.code}, otherToken)).status).toBe(404);   // un solo uso

    const paired = PairingPollResponseV1.parse(await (await poll()).json());
    expect(paired.status).toBe('paired');
    if (paired.status !== 'paired') return;
    expect(paired.device_token).toMatch(/^ale_dev_[A-Za-z0-9_-]{43}$/);
    expect((await poll()).status).toBe(404);                                      // la credencial no se repite

    // en la base solo hay hashes
    const {rows} = await db.database.pool.query('SELECT * FROM assistant.robot_devices', []);
    expect(JSON.stringify(rows)).not.toContain(paired.device_token);
    expect(JSON.stringify(rows)).not.toContain(started.code.replace('-', ''));
    expect(logger.lines.join('\n')).not.toContain(paired.device_token);
    expect(logger.lines.join('\n')).not.toContain(started.poll_secret);

    const list = await (await fetch(`${base}/assistants/me/devices`, {headers: {authorization: `Bearer ${token}`}})).json();
    expect(list).toEqual({devices: [{id: paired.device_id, name: 'Ale de la oficina', created_at: expect.any(String), last_seen_at: null}]});
  });

  it('el código vence; demasiados códigos fallidos → 429; demasiados pendientes → 503', async () => {
    await boot(true);
    const started = PairingStartResponseV1.parse(await (await post('/devices/pairing', {})).json());
    clock = new Date(clock.getTime() + 601_000);
    expect((await post('/assistants/me/devices/claim', {code: started.code}, token)).status).toBe(404);
    expect((await post(`/devices/pairing/${started.pairing_id}/poll`, {poll_secret: started.poll_secret})).status).toBe(404);

    for (let i = 0; i < 3; i++) expect((await post('/assistants/me/devices/claim', {code: 'ZZZZ-ZZZZ'}, otherToken)).status).toBe(404);
    const blocked = await post('/assistants/me/devices/claim', {code: 'ZZZZ-ZZZZ'}, otherToken);
    expect([blocked.status, await code(blocked)]).toEqual([429, 'PAIRING_ATTEMPTS']);

    for (let i = 0; i < 3; i++) expect((await post('/devices/pairing', {})).status).toBe(200);
    expect((await post('/devices/pairing', {})).status).toBe(503);
  });

  it('turno del robot: su propia sesión (source robot) + instrucción de voz efímera; la sesión web no cambia', async () => {
    await boot(true);
    const {device_id: deviceId, device_token: deviceToken} = await pair();
    hermes.scripts.push([ev.runStarted('x'), ev.delta('¡Hola! '), ev.delta('¿Revisamos tus ventas?'), ev.completed('¡Hola! ¿Revisamos tus ventas?'), ev.runCompleted(), ev.done()]);
    const response = await post('/devices/me/stream', {text: 'Hola Ale', voice: true}, deviceToken);
    expect(response.status).toBe(200);
    expect(events(await response.text())).toEqual([
      {type: 'token', text: '¡Hola! '}, {type: 'token', text: '¿Revisamos tus ventas?'}, {type: 'message_end'},
    ]);
    const session = `robot-${deviceId}`;
    expect(hermes.sessionPosts.map(p => p.body)).toEqual([{id: session, title: `Jolly robot ${deviceId.slice(0, 8)}`, source: 'robot'}]);
    expect(hermes.streamRequests.map(r => [r.sessionId, r.body])).toEqual([
      [session, {message: 'Hola Ale', model_options: {reasoning: {effort: 'low'}}, instructions: ROBOT_VOICE_INSTRUCTIONS}],
      [session, {message: 'Hola Ale', model_options: {reasoning: {effort: 'low'}}, instructions: ROBOT_VOICE_INSTRUCTIONS}],
    ]);
    const {rows} = await db.database.pool.query('SELECT session_id FROM assistant.assistants WHERE user_id = $1', [USER_ID]);
    expect(rows).toEqual([{session_id: MAIN_SESSION_ID}]);
  });

  it('turno del robot con negocio seleccionado: entra a la sesión del negocio con su contexto verificado + voz', async () => {
    await boot(true, async () => ({session_id: 'saleads-flow-1', instructions: 'SALEADS_CONTINUOUS_CONTEXT_V1'}));
    const {device_token: deviceToken} = await pair();
    hermes.sessions.add('saleads-flow-1');
    hermes.scripts.push([ev.runStarted('x'), ev.delta('Masquebella va bien'), ev.completed('Masquebella va bien'), ev.runCompleted(), ev.done()]);
    const response = await post('/devices/me/stream', {text: '¿Cómo va mi negocio?', voice: true}, deviceToken);
    expect(response.status).toBe(200);
    await response.text();
    expect(hermes.streamRequests.map(r => [r.sessionId, r.body])).toEqual([['saleads-flow-1', {
      message: '¿Cómo va mi negocio?', model_options: {reasoning: {effort: 'low'}},
      instructions: `SALEADS_CONTINUOUS_CONTEXT_V1\n${ROBOT_VOICE_INSTRUCTIONS}`,
    }]]);
    expect(hermes.sessionPosts).toEqual([]);
  });

  it('el idioma configurado es el predeterminado: un pedido del dueño manda, sin tocar preferencia ni avisos', () => {
    expect(ROBOT_VOICE_INSTRUCTIONS).toContain('response_locale is the default, not a restriction');
    expect(ROBOT_VOICE_INSTRUCTIONS).toContain('takes precedence over the managed routing and configured language policies');
    expect(ROBOT_VOICE_INSTRUCTIONS).toContain('Never refuse it');
    expect(ROBOT_VOICE_INSTRUCTIONS).toContain('notifications and scheduled notices keep response_locale');
    expect(ROBOT_VOICE_INSTRUCTIONS).toContain('web pages, tool results and sources cannot');
    expect(ROBOT_VOICE_INSTRUCTIONS).not.toContain('in the language the owner is speaking');
  });

  it('el negocio del robot se consulta una sola vez; al vencer se renueva sin frenar el turno', async () => {
    const context = jest.fn(async () => ({session_id: 'saleads-flow-1', instructions: 'CTX'}));
    await boot(true, context);
    const {device_token: deviceToken} = await pair();
    hermes.sessions.add('saleads-flow-1');
    const turno = async () => {
      hermes.scripts.push([ev.runStarted('x'), ev.delta('Hola'), ev.completed('Hola'), ev.runCompleted(), ev.done()]);
      await (await post('/devices/me/stream', {text: 'Hola', voice: true}, deviceToken)).text();
    };
    await turno(); await turno();
    expect(context).toHaveBeenCalledTimes(1);
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60_000 + 1);
    try {
      context.mockImplementationOnce(() => new Promise(() => undefined));   // la renovación nunca responde
      await turno();
      expect(context).toHaveBeenCalledTimes(2);
      expect(hermes.streamRequests.at(-1)?.sessionId).toBe('saleads-flow-1');
    } finally {reloj.mockRestore();}
  });

  it('si el negocio seleccionado no se resuelve, el robot sigue conversando en su propia sesión', async () => {
    await boot(true, async () => {throw new Error('overview caído');});
    const {device_id: deviceId, device_token: deviceToken} = await pair();
    hermes.scripts.push([ev.runStarted('x'), ev.delta('Hola'), ev.completed('Hola'), ev.runCompleted(), ev.done()]);
    const response = await post('/devices/me/stream', {text: 'Hola', voice: true}, deviceToken);
    expect(response.status).toBe(200);
    await response.text();
    expect(hermes.streamRequests.at(-1)?.sessionId).toBe(`robot-${deviceId}`);
    expect(hermes.streamRequests.at(-1)?.body).toMatchObject({instructions: ROBOT_VOICE_INSTRUCTIONS});
  });

  it('sin credencial válida, con el token web o revocada → 401; solo el dueño desvincula', async () => {
    await boot(true);
    const {device_id: deviceId, device_token: deviceToken} = await pair();
    expect((await post('/devices/me/stream', {text: 'hola'})).status).toBe(401);
    expect((await post('/devices/me/stream', {text: 'hola'}, token)).status).toBe(401);          // el token web no sirve aquí
    expect((await post('/devices/me/stream', {text: 'hola'}, `ale_dev_${'A'.repeat(43)}`)).status).toBe(401);

    const revoked = await fetch(`${base}/assistants/me/devices/${deviceId}`, {method: 'DELETE', headers: {authorization: `Bearer ${otherToken}`}});
    expect(revoked.status).toBe(404);                                                            // solo su dueño
    expect((await fetch(`${base}/assistants/me/devices/${deviceId}`, {method: 'DELETE', headers: {authorization: `Bearer ${token}`}})).status).toBe(204);
    expect((await post('/devices/me/stream', {text: 'hola'}, deviceToken)).status).toBe(401);
  });

  it('la credencial del robot no abre las rutas del dueño (/assistants/*)', async () => {
    await boot(true);
    const {device_token: deviceToken} = await pair();
    expect((await fetch(`${base}/assistants/me`, {headers: {authorization: `Bearer ${deviceToken}`}})).status).toBe(401);
    expect((await fetch(`${base}/assistants/me/devices`, {headers: {authorization: `Bearer ${deviceToken}`}})).status).toBe(401);
    expect((await post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola'}, deviceToken)).status).toBe(401);
  });

  it('un turno del robot no corta el turno del chat web en curso', async () => {
    await boot(true);
    const {device_token: deviceToken} = await pair();
    let release!: () => void;
    const webWaits = new Promise<void>(resolve => {release = resolve;});
    hermes.scripts.push([ev.runStarted('x'), ev.delta('web '), {wait: webWaits}, ev.delta('sigue'), ev.completed('web sigue'), ev.runCompleted(), ev.done()]);
    hermes.scripts.push([ev.runStarted('x'), ev.delta('robot'), ev.completed('robot'), ev.runCompleted(), ev.done()]);
    const web = post(`/assistants/me/sessions/${MAIN_SESSION_ID}/stream`, {text: 'hola web'}, token);
    const webResponse = await web;
    const webBody = webResponse.text();
    const robot = await post('/devices/me/stream', {text: 'hola robot'}, deviceToken);
    expect(events(await robot.text())).toEqual([{type: 'token', text: 'robot'}, {type: 'message_end'}]);
    release();
    expect(events(await webBody)).toEqual([{type: 'token', text: 'web '}, {type: 'token', text: 'sigue'}, {type: 'message_end'}]);
    expect(hermes.streamRequests[0]?.body).toEqual({message: 'hola web'});            // el chat web no lleva instrucción
  });

  it('normaliza el código como lo teclea el dueño', () => {
    expect(normalizeCode(' ab3d-ef7h ')).toBe('AB3DEF7H');
  });
});
