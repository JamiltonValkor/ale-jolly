import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {AssistantStateV1} from '../src/contracts/v1';
import type {HealthObservation} from '../src/hermes/hermes-client';
import {configureApp} from '../src/http/configure-app';
import {classifyHealth, nextTransition, type VmObservation} from '../src/lifecycle/readiness';
import {ReadinessRepository} from '../src/lifecycle/readiness-repository';
import {ReadinessStateReader} from '../src/lifecycle/readiness-state-reader';
import {AssistantRepository, type AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {API_SERVER_KEY, answered, FakeHermes, FakeInstances, HEALTHY, HEALTHY_CHECKS, NO_MODEL, seedAssistant, VM_IP} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {testKeys, USER_ID, ISSUER, type TestKeys} from './support/tokens';

const cipher = new FieldCipher(Buffer.alloc(32, 9));
const T0 = Date.parse('2027-10-15T12:00:00.000Z');

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

describe('reglas de readiness (OCB-008)', () => {
  it('configure_ai solo con platform=hermes-agent y todos los checks ok salvo model', () => {
    expect(classifyHealth(NO_MODEL)).toBe('needs_model');
    expect(classifyHealth(HEALTHY)).toBe('healthy');
    expect(classifyHealth(answered({...HEALTHY_CHECKS, model: 'degraded', disk: 'degraded'}))).toBe('agent_degraded');
    expect(classifyHealth(answered({...HEALTHY_CHECKS, session_store: 'unavailable'}))).toBe('agent_degraded');
    expect(classifyHealth(answered({...HEALTHY_CHECKS, model: 'degraded'}, 'other'))).toBe('not_responding');
    expect(classifyHealth(answered({}))).toBe('agent_degraded');
    expect(classifyHealth({kind: 'unreachable'})).toBe('not_responding');
    expect(classifyHealth({kind: 'http_error', status: 500})).toBe('not_responding');
    expect(classifyHealth({kind: 'unauthorized'})).toBe('unauthorized');
  });

  const row = (overrides: Partial<AssistantRow> = {}): AssistantRow => ({
    user_id: USER_ID, status: 'activating', step: 'preparing_environment', instance_name: 'sa-assistant-x', zone: 'z',
    private_ip: null, api_server_key_enc: Buffer.from('x'), bundle_version: 'b', ai_provider: null, ai_model: null,
    ai_configured: false, session_id: null, activation_started_at: new Date(T0), ready_since: null, attempts: 1,
    created_at: new Date(T0), updated_at: new Date(T0), deleted_at: null, timezone: null, ...overrides,
  });
  const at = (ms: number) => new Date(T0 + ms);
  const running = (hermes: VmObservation & {vm: 'running'} extends {hermes: infer H} ? H : never): VmObservation => ({vm: 'running', ip: VM_IP, hermes});

  it('mapea cada observación de la VM al paso visible', () => {
    expect(nextTransition(row(), {vm: 'booting'}, at(1000), 90_000)).toBeNull();
    expect(nextTransition(row({step: 'installing_agent'}), {vm: 'booting'}, at(1000), 90_000)).toMatchObject({step: 'preparing_environment'});
    expect(nextTransition(row(), running('not_responding'), at(1000), 90_000)).toMatchObject({status: 'activating', step: 'installing_agent', privateIp: VM_IP});
    expect(nextTransition(row(), running('agent_degraded'), at(1000), 90_000)).toMatchObject({step: 'installing_agent'});
    expect(nextTransition(row(), running('needs_model'), at(1000), 90_000)).toMatchObject({step: 'configure_ai', milestone: 'configure_ai'});
    expect(nextTransition(row({step: 'configure_ai', private_ip: VM_IP}), running('needs_model'), at(1000), 90_000)).toBeNull();
    expect(nextTransition(row({step: 'installing_agent', private_ip: VM_IP}), running('unauthorized'), at(1000), 90_000)).toBeNull();
    expect(nextTransition(row(), {vm: 'unknown'}, at(1000), 90_000)).toBeNull();
  });

  it('nunca dice ready por una VM encendida: ready exige ai_configured (turno de prueba ok)', () => {
    expect(nextTransition(row(), running('healthy'), at(1000), 90_000)).toMatchObject({status: 'activating', step: 'configure_ai'});
    expect(nextTransition(row({ai_configured: true}), running('healthy'), at(1000), 90_000))
      .toMatchObject({status: 'ready', step: null, milestone: 'ready'});
    expect(nextTransition(row({ai_configured: true}), running('needs_model'), at(1000), 90_000)).toMatchObject({status: 'activating', step: 'configure_ai'});
  });

  it('404 y apagada solo cuentan tras la gracia (no pisan una creación o un start recién pedidos)', () => {
    expect(nextTransition(row(), {vm: 'missing'}, at(30_000), 90_000)).toBeNull();
    expect(nextTransition(row(), {vm: 'missing'}, at(120_000), 90_000)).toMatchObject({status: 'failed', event: {cause: 'vm_create_failed'}});
    expect(nextTransition(row({step: 'installing_agent'}), {vm: 'missing'}, at(1000), 90_000)).toMatchObject({status: 'failed', event: {kind: 'readiness.vm_missing'}});
    expect(nextTransition(row(), {vm: 'stopped'}, at(30_000), 90_000)).toBeNull();
    expect(nextTransition(row(), {vm: 'stopped'}, at(120_000), 90_000)).toMatchObject({status: 'stopped', step: null});
  });
});

describe('GET /assistants/me con readiness real (OCB-008)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let token: string;
  let app: INestApplication;
  let instances: FakeInstances;
  let hermes: FakeHermes;
  let reader: ReadinessStateReader;
  let logger: CaptureLogger;
  let nowMs: number;
  let budgetMs: number;

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    token = await keys.sign({sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600});
  });
  afterAll(async () => {await db.close();});

  async function boot() {
    const repository = new AssistantRepository(db.database);
    reader = new ReadinessStateReader({healthTimeoutMs: 3000, budgetMs, cacheTtlMs: 5000, graceMs: 90_000}, {
      repository, readiness: new ReadinessRepository(db.database), instances, hermes, cipher, now: () => new Date(nowMs),
    });
    logger = new CaptureLogger();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher,
      stateReader: reader,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.init();
  }

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events', []);
    nowMs = T0;
    budgetMs = 3500;
    instances = new FakeInstances();
    hermes = new FakeHermes();
    await boot();
  });
  afterEach(async () => {await app.close();});

  const me = async () => AssistantStateV1.parse((await request(app.getHttpServer())
    .get('/assistants/me').set('Authorization', `Bearer ${token}`).expect(200)).body);
  const advance = (ms: number) => {nowMs += ms; reader.invalidate(USER_ID);};
  const seed = (overrides: Partial<Parameters<typeof seedAssistant>[2]> = {}) =>
    seedAssistant(db.database, cipher, {userId: USER_ID, startedAt: new Date(T0), ...overrides});
  const events = async () => (await db.database.pool.query(
    'SELECT kind, cause_code, detail_safe FROM assistant.assistant_events ORDER BY id', [])).rows as Array<Record<string, unknown>>;
  const dbRow = async () => (await db.database.pool.query('SELECT * FROM assistant.assistants', [])).rows[0] as Record<string, unknown>;

  it('recorre preparing_environment → installing_agent → configure_ai y marca el hito una vez', async () => {
    await seed();
    instances.setStatus('STAGING');
    expect(await me()).toMatchObject({status: 'activating', step: 'preparing_environment', ready_since: null});

    advance(20_000);
    instances.setStatus('RUNNING');
    hermes.healthDefault = {kind: 'unreachable'};
    expect(await me()).toMatchObject({status: 'activating', step: 'installing_agent', ready_since: null});
    expect(String((await dbRow()).private_ip)).toBe(VM_IP);

    advance(20_000);
    hermes.healthDefault = answered({...HEALTHY_CHECKS, model: 'degraded', gateway: 'degraded'});
    expect((await me()).step).toBe('installing_agent');

    advance(20_000);
    hermes.healthDefault = NO_MODEL;
    const ready = await me();
    expect(ready).toMatchObject({status: 'activating', step: 'configure_ai', slow: false});
    expect(ready.ready_since).toBe(new Date(T0 + 60_000).toISOString());
    // Health con la IP privada y el API_SERVER_KEY de la VM.
    expect(hermes.healthTargets.at(-1)).toEqual({ip: VM_IP, apiServerKey: API_SERVER_KEY});

    advance(20_000);
    expect((await me()).ready_since).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('nunca dice ready sin el turno de prueba, aunque Hermes reporte todo ok', async () => {
    await seed({step: 'installing_agent'});
    hermes.healthDefault = HEALTHY;
    expect(await me()).toMatchObject({status: 'activating', step: 'configure_ai', ai: {configured: false}});
  });

  it('con la IA ya probada (p. ej. al reactivar) llega a ready y mueve ready_since', async () => {
    await seed({step: 'installing_agent', aiConfigured: true, provider: 'openrouter', model: 'openai/gpt-4o-mini',
      readySince: new Date(T0 - 86_400_000)});
    hermes.healthDefault = HEALTHY;
    advance(1000);
    expect(await me()).toMatchObject({status: 'ready', step: null, slow: false, ai: {configured: true, provider: 'openrouter'},
      ready_since: new Date(T0 + 1000).toISOString()});
  });

  it('slow=true a los 5 minutos sin llegar a configure_ai, y false al llegar', async () => {
    await seed();
    instances.setStatus('RUNNING');
    hermes.healthDefault = {kind: 'unreachable'};
    advance(4 * 60_000);
    expect((await me()).slow).toBe(false);
    advance(61_000);
    expect(await me()).toMatchObject({step: 'installing_agent', slow: true});
    hermes.healthDefault = NO_MODEL;
    advance(5000);
    expect(await me()).toMatchObject({step: 'configure_ai', slow: false});
  });

  it('un 401 de Hermes no avanza y deja un evento HERMES_AUTH_FAILED (sin repetirlo en cada consulta)', async () => {
    await seed({step: 'installing_agent', privateIp: VM_IP});
    hermes.healthDefault = {kind: 'unauthorized'};
    expect((await me()).step).toBe('installing_agent');
    advance(6000);
    expect((await me()).step).toBe('installing_agent');
    expect(await events()).toEqual([{kind: 'readiness.hermes_auth_failed', cause_code: 'unknown', detail_safe: 'code=HERMES_AUTH_FAILED'}]);
    expect(logger.lines.join('\n')).not.toContain(API_SERVER_KEY);
  });

  it('VM borrada por fuera → failed con evento; VM apagada → stopped', async () => {
    await seed({step: 'installing_agent'});
    instances.view = null;
    expect(await me()).toMatchObject({status: 'failed', step: null});
    expect((await events())[0]).toMatchObject({kind: 'readiness.vm_missing', cause_code: 'unknown'});

    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events', []);
    instances = new FakeInstances();
    await app.close();
    await boot();
    await seed({step: 'configure_ai'});
    instances.setStatus('TERMINATED');
    advance(91_000);
    expect(await me()).toMatchObject({status: 'stopped', step: null});
  });

  it('responde dentro del presupuesto aunque la VM no escuche, y usa la caché después', async () => {
    budgetMs = 300;
    await app.close();
    await boot();
    await seed({step: 'installing_agent'});
    let release: (value: HealthObservation) => void = () => undefined;
    hermes.healthDefault = () => new Promise<HealthObservation>(resolve => {release = resolve;});
    const started = Date.now();
    expect(await me()).toMatchObject({status: 'activating', step: 'installing_agent'});
    expect(Date.now() - started).toBeLessThan(2000);
    release(NO_MODEL);
    await new Promise(resolve => setImmediate(resolve));
    const calls = instances.getCalls;
    expect((await me()).step).toBe('configure_ai');
    expect(instances.getCalls).toBe(calls);
  });

  it('no observa sin VM reclamada ni fuera de la activación', async () => {
    await seed({status: 'ready', step: null, aiConfigured: true, provider: 'openrouter', model: 'm'});
    expect((await me()).status).toBe('ready');
    expect(instances.getCalls).toBe(0);
  });
});
