import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {hermesConfig} from '../src/activation/hermes-files';
import {AiConfigService} from '../src/ai/ai-config.service';
import {AiRepository} from '../src/ai/ai-repository';
import {AppModule} from '../src/app.module';
import {HermesConfigWriter} from '../src/assistant-config/hermes-config-writer';
import {canonicalTimezone} from '../src/assistant-config/timezone';
import {TimezoneService} from '../src/assistant-config/timezone.service';
import {UserLocks} from '../src/assistant-config/user-locks';
import {ComputeError} from '../src/compute/compute-client';
import {AssistantStateV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {RowAssistantStateReader} from '../src/state/assistant-state';
import {createdVmItems, FakeHermes, FakeInstances, HEALTHY, seedAssistant, VM_IP} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const cipher = new FieldCipher(Buffer.alloc(32, 7));
const MCP = {mcpUrl: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', scope: 'openid offline_access saleads-mcp'};
const MODEL = 'openai/gpt-4o-mini';
const KEY = 'sk-or-v1-SECRET-0123456789'; // gitleaks:allow -- synthetic test credential
const T0 = Date.parse('2026-10-31T23:07:07.000Z');

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

describe('zona horaria canónica (OCB-016)', () => {
  it('acepta IANA por Intl y guarda el nombre canónico; rechaza lo demás', () => {
    expect(canonicalTimezone('America/Bogota')).toBe('America/Bogota');
    expect(canonicalTimezone('america/bogota')).toBe('America/Bogota');
    expect(canonicalTimezone('UTC')).toBe('UTC');
    for (const value of ['', 'Mars/Olympus', 'x'.repeat(65), '+05:00']) expect(canonicalTimezone(value)).toBeNull();
  });
});

describe('PUT /assistants/me/timezone (OCB-016)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let token: string;
  let app: INestApplication;
  let instances: FakeInstances;
  let hermes: FakeHermes;
  let logger: CaptureLogger;
  let timezones: TimezoneService;
  let ai: AiConfigService;
  let nowMs: number;
  let invalidated: string[];

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    token = await keys.sign({sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600});
  });
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events', []);
    nowMs = T0;
    invalidated = [];
    const now = () => new Date(nowMs);
    const sleep = async (ms: number) => {nowMs += ms;};
    instances = new FakeInstances();
    hermes = new FakeHermes();
    hermes.healthDefault = HEALTHY;
    const repository = new AssistantRepository(db.database);
    const locks = new UserLocks();
    timezones = new TimezoneService({
      repository, writer: new HermesConfigWriter(MCP, instances), locks, now, onStateChanged: id => invalidated.push(id),
    });
    ai = new AiConfigService({
      mcp: MCP, deadlineMs: 85_000, ackTimeoutMs: 60_000, probeTimeoutMs: 45_000, pollIntervalMs: 2000, healthTimeoutMs: 3000,
    }, {repository, ai: new AiRepository(db.database), instances, hermes, cipher, now, sleep, locks});
    logger = new CaptureLogger();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher,
      stateReader: new RowAssistantStateReader(repository, now),
      ai,
      timezone: timezones,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.init();
  });
  afterEach(async () => {await app.close();});

  const put = (body: unknown) => request(app.getHttpServer())
    .put('/assistants/me/timezone').set('Authorization', `Bearer ${token}`).send(body as object);
  const seedReady = (status = 'ready') => seedAssistant(db.database, cipher, {
    userId: USER_ID, status, step: null, privateIp: VM_IP, startedAt: new Date(T0 - 3_600_000),
    aiConfigured: true, provider: 'openrouter', model: MODEL, readySince: new Date(T0 - 1_800_000),
  });
  const events = async () => (await db.database.pool.query(
    'SELECT kind, cause_code, detail_safe FROM assistant.assistant_events ORDER BY id', [])).rows as Array<Record<string, unknown>>;
  const storedTimezone = async () => ((await db.database.pool.query('SELECT timezone FROM assistant.assistants', [])).rows[0] as {timezone: string | null}).timezone;

  it('VM RUNNING: guarda la zona canónica y reescribe solo hermes-config (modelo de la fila + zona) con el fingerprint', async () => {
    await seedReady();
    const before = createdVmItems();
    const response = await put({timezone: 'america/bogota'}).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const state = AssistantStateV1.parse(response.body);
    expect(state).toMatchObject({status: 'ready', timezone: 'America/Bogota', ai: {configured: true, provider: 'openrouter', model: MODEL}});
    expect(await storedTimezone()).toBe('America/Bogota');

    expect(instances.sets).toHaveLength(1);
    expect(instances.sets[0]!.fingerprint).toBe('fp-0');
    const expected = hermesConfig({mcp: MCP, model: {provider: 'openrouter', model: MODEL}, timezone: 'America/Bogota'});
    expect(instances.item('hermes-config')).toBe(expected);
    expect(expected).toContain('timezone: "America/Bogota"\n');
    expect(expected).toContain('model: { provider: "openrouter", default: "openai/gpt-4o-mini" }');
    for (const item of before.filter(i => i.key !== 'hermes-config')) expect(instances.item(item.key)).toBe(item.value);
    expect(instances.view!.items.map(item => item.key)).toEqual(before.map(item => item.key));
    expect((await events()).at(-1)).toMatchObject({kind: 'timezone.updated', detail_safe: 'result=applied'});
    expect(invalidated).toEqual([USER_ID]);

    // Misma zona otra vez: nada que escribir.
    await put({timezone: 'America/Bogota'}).expect(200);
    expect(instances.sets).toHaveLength(1);
    expect((await events()).at(-1)).toMatchObject({detail_safe: 'result=unchanged'});
  });

  it('un 412 relee la metadata y reintenta una vez', async () => {
    await seedReady();
    instances.conflictOnce = true;
    await put({timezone: 'Europe/Madrid'}).expect(200);
    expect(instances.sets).toHaveLength(2);
    expect(instances.item('hermes-config')).toContain('timezone: "Europe/Madrid"');
  });

  it('VM apagada o inexistente: solo se guarda; el start la aplica con la VM aún apagada', async () => {
    await seedReady('stopped');
    instances.setStatus('TERMINATED');
    expect(AssistantStateV1.parse((await put({timezone: 'America/Lima'}).expect(200)).body).timezone).toBe('America/Lima');
    expect(instances.sets).toHaveLength(0);
    expect((await events()).at(-1)).toMatchObject({kind: 'timezone.updated', detail_safe: 'result=deferred'});

    await timezones.syncBeforeStart(USER_ID);
    expect(instances.sets).toHaveLength(1);
    expect(instances.item('hermes-config')).toContain('timezone: "America/Lima"');
    expect((await events()).at(-1)).toMatchObject({kind: 'config.synced'});

    await db.database.pool.query("UPDATE assistant.assistants SET status = 'ready'", []);
    instances.view = null;
    await put({timezone: 'America/Santiago'}).expect(200);
    expect(await storedTimezone()).toBe('America/Santiago');
    expect((await events()).at(-1)).toMatchObject({detail_safe: 'result=deferred'});
  });

  it('un fallo de Compute no rechaza el cambio: la zona queda guardada y el evento lleva la causa', async () => {
    await seedReady();
    instances.setMetadata = async () => {throw new ComputeError(503, 'backendError');};
    const state = AssistantStateV1.parse((await put({timezone: 'Europe/Madrid'}).expect(200)).body);
    expect(state.timezone).toBe('Europe/Madrid');
    expect((await events()).at(-1)).toMatchObject({kind: 'timezone.apply_failed', cause_code: 'config_apply_failed', detail_safe: 'status=503 reason=backendError'});
  });

  it('zona inválida → 400 sin tocar la VM; sin asistente → 404', async () => {
    await seedReady();
    for (const body of [{timezone: 'Mars/Olympus'}, {timezone: 'x'.repeat(65)}, {}, {timezone: 'UTC', extra: 1}, {timezone: 'America/Bogota\nmodel: x'}]) {
      expect(ErrorResponseV1.parse((await put(body).expect(400)).body).code).toBe('INVALID_REQUEST');
    }
    expect(instances.sets).toHaveLength(0);
    await db.database.pool.query('TRUNCATE assistant.assistants', []);
    expect(ErrorResponseV1.parse((await put({timezone: 'UTC'}).expect(404)).body).code).toBe('NOT_FOUND');
  });

  it('PUT /ai usa la zona de la fila; en paralelo con PUT /timezone ninguno pisa al otro', async () => {
    await seedAssistant(db.database, cipher, {
      userId: USER_ID, step: 'configure_ai', privateIp: VM_IP, startedAt: new Date(T0 - 120_000), readySince: new Date(T0 - 60_000),
    });
    await db.database.pool.query("UPDATE assistant.assistants SET timezone = 'America/Lima'", []);
    const configuring = request(app.getHttpServer()).put('/assistants/me/ai').set('Authorization', `Bearer ${token}`)
      .send({provider: 'openrouter', model: MODEL, api_key: KEY});
    const [aiResponse, tzResponse] = await Promise.all([configuring, put({timezone: 'Europe/Madrid'})]);
    expect(aiResponse.status).toBe(200);
    expect(aiResponse.body).toEqual({result: 'ok'});
    expect(tzResponse.status).toBe(200);
    // En serie (mismos locks): cada write lleva la zona de la fila y el último conserva el modelo ya guardado.
    expect(instances.sets.length).toBeGreaterThanOrEqual(2);
    for (const set of instances.sets) expect(set.items.find(item => item.key === 'hermes-config')!.value).toMatch(/\ntimezone: "(America\/Lima|Europe\/Madrid)"\n/);
    expect(instances.item('hermes-config')).toBe(hermesConfig({mcp: MCP, model: {provider: 'openrouter', model: MODEL}, timezone: 'Europe/Madrid'}));
    expect(instances.item('hermes-env')).toBe(`OPENROUTER_API_KEY=${KEY}\nHERMES_API_TIMEOUT=300\nBRAIN_LLM_MODEL=${MODEL}\n`);
  });

  it('ningún log ni evento lleva la key ni valores de metadata', async () => {
    await seedReady();
    await put({timezone: 'Europe/Madrid'}).expect(200);
    const dump = JSON.stringify(await events()) + logger.lines.join('\n');
    expect(dump).not.toContain('apikey-SECRET');
    expect(dump).not.toContain('mcp-SECRET');
  });
});
