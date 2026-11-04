import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AiConfigService} from '../src/ai/ai-config.service';
import {hermesConfig} from '../src/activation/hermes-files';
import {classifyProbeFailure, hermesEnv} from '../src/ai/ai-outcome';
import {AiRepository} from '../src/ai/ai-repository';
import {AI_PROVIDERS, findProvider} from '../src/ai/providers';
import {META_MODEL_ID, META_PROVIDER_ID, MIN_META_WATCHER_VERSION} from '../src/ai/meta-model';
import {AppModule} from '../src/app.module';
import {computeAppliedVersion} from '../src/compute/metadata';
import {AiConfigResponseV1, AssistantStateV1, ErrorResponseV1, ProvidersResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {ReadinessRepository} from '../src/lifecycle/readiness-repository';
import {ReadinessStateReader} from '../src/lifecycle/readiness-state-reader';
import {AssistantRepository, type AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {API_SERVER_KEY, createdVmItems, FakeHermes, FakeInstances, HEALTHY, INSTANCE, NO_MODEL, seedAssistant, VM_IP} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const cipher = new FieldCipher(Buffer.alloc(32, 9));
const T0 = Date.parse('2026-11-03T16:57:32.000Z');
const MCP = {mcpUrl: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', scope: 'openid offline_access saleads-mcp'};
const KEY = 'sk-or-v1-SECRETKEY-0123456789abcdef0123456789'; // gitleaks:allow -- synthetic test credential
const NEW_KEY = 'sk-or-v1-NEWSECRET-fedcba9876543210fedcba98'; // gitleaks:allow -- synthetic test credential
const MODEL = 'openai/gpt-4o-mini';

/** Textos reales de Hermes v0.21.6 (turn_failure_copy.py / agent_init.py) y de OCB-002 G-07. */
const REJECTED_KEY = "OpenRouter rejected your API key, so the model can't be reached. Update it in Settings → Providers, or run `hermes setup` in a terminal.\nProvider said: HTTP 401";
const SMALL_MODEL = 'Model meta/llama-3-8b has a context window of 8,192 tokens, which is below the minimum 64,000 required by Hermes Agent.  Choose a model with at least 64K context.';
const MISSING_MODEL = "Model 'nope/model' isn't available on OpenRouter. Pick a different model with /model (or `hermes model` in a terminal).";
const BILLING = "OpenRouter rejected the request and retrying won't help. Provider said: the account's usage or credit limit is reached";

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

describe('clasificación del turno de prueba (OCB-010)', () => {
  it('mapea los textos de Hermes a invalid_key / incompatible_model / provider_rejected', () => {
    expect(classifyProbeFailure(REJECTED_KEY)).toBe('invalid_key');
    expect(classifyProbeFailure('Anthropic rejected the sign-in')).toBe('invalid_key');
    expect(classifyProbeFailure(SMALL_MODEL)).toBe('incompatible_model');
    expect(classifyProbeFailure(MISSING_MODEL)).toBe('incompatible_model');
    expect(classifyProbeFailure(BILLING)).toBe('provider_rejected');
    expect(classifyProbeFailure('OpenRouter refused this request because of a policy on your account. HTTP 403')).toBe('provider_rejected');
    expect(classifyProbeFailure('No API key found for provider openrouter')).toBe('key_not_loaded');
    expect(classifyProbeFailure('')).toBe('provider_rejected');
  });

  it('config.yaml lleva modelo, approvals.mode "off", zona y el MCP, sin fallback_providers', () => {
    const yaml = hermesConfig({mcp: MCP, model: {provider: AI_PROVIDERS.find(p => p.id === 'openrouter')!.id, model: MODEL}, timezone: 'America/Mexico_City'});
    expect(yaml).toContain('timezone: "America/Mexico_City"\n');
    expect(yaml).toContain('model: { provider: "openrouter", default: "openai/gpt-4o-mini" }');
    expect(yaml).toContain('approvals:\n  mode: "off"\n');
    expect(yaml).toContain('url: "https://dev.saleads.ai/mcp"');
    expect(yaml).not.toContain('fallback');
  });
});

describe('PUT /assistants/me/ai y GET /assistants/me/providers (OCB-010)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let token: string;
  let app: INestApplication;
  let instances: FakeInstances;
  let hermes: FakeHermes;
  let logger: CaptureLogger;
  let nowMs: number;

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    token = await keys.sign({sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600});
  });
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events', []);
    nowMs = T0;
    const now = () => new Date(nowMs);
    const sleep = async (ms: number) => {nowMs += ms;};
    instances = new FakeInstances();
    hermes = new FakeHermes();
    hermes.healthDefault = HEALTHY;
    const repository = new AssistantRepository(db.database);
    const reader = new ReadinessStateReader({healthTimeoutMs: 3000, budgetMs: 3500, cacheTtlMs: 5000, graceMs: 90_000}, {
      repository, readiness: new ReadinessRepository(db.database), instances, hermes, cipher, now,
    });
    const ai = new AiConfigService({
      mcp: MCP, deadlineMs: 85_000, ackTimeoutMs: 60_000, probeTimeoutMs: 45_000, pollIntervalMs: 2000, healthTimeoutMs: 3000,
    }, {repository, ai: new AiRepository(db.database), instances, hermes, cipher, now, sleep, onStateChanged: id => reader.invalidate(id)});
    logger = new CaptureLogger();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher,
      stateReader: reader,
      ai,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.init();
  });
  afterEach(async () => {await app.close();});

  const put = (body: Record<string, unknown>) => request(app.getHttpServer())
    .put('/assistants/me/ai').set('Authorization', `Bearer ${token}`).send(body);
  const configure = async (body: Record<string, unknown> = {}) => {
    const response = await put({provider: 'openrouter', model: MODEL, api_key: KEY, ...body}).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return AiConfigResponseV1.parse(response.body).result;
  };
  const me = async () => AssistantStateV1.parse((await request(app.getHttpServer())
    .get('/assistants/me').set('Authorization', `Bearer ${token}`).expect(200)).body);
  const seedAtConfigureAi = () => seedAssistant(db.database, cipher, {
    userId: USER_ID, step: 'configure_ai', privateIp: VM_IP, startedAt: new Date(T0 - 120_000), readySince: new Date(T0 - 60_000),
  });
  const events = async () => (await db.database.pool.query(
    'SELECT kind, cause_code, detail_safe FROM assistant.assistant_events ORDER BY id', [])).rows as Array<Record<string, unknown>>;
  const dumpDb = async () => JSON.stringify((await db.database.pool.query(`
    SELECT (SELECT json_agg(a) FROM assistant.assistants a) AS a, (SELECT json_agg(e) FROM assistant.assistant_events e) AS e`, [])).rows);

  it('delivers only the account relay credential and HTTPS base to managed root, workers and auxiliaries', async () => {
    await seedAtConfigureAi();
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? String(MIN_META_WATCHER_VERSION) : guest(name, key);
    const relayBase = 'https://app.example.invalid/meta-inference/v1';
    const relayCredential = 'mr1.c3ludGhldGlj.bounded-account-inference-credential';
    const now = () => new Date(nowMs), sleep = async (ms: number) => {nowMs += ms;};
    const managed = new AiConfigService({mcp: MCP, deadlineMs: 85_000, ackTimeoutMs: 60_000, probeTimeoutMs: 45_000,
      pollIntervalMs: 2000, healthTimeoutMs: 3000, managedMeta: {enabled: true, userId: 'other-pilot', allUsers: true}, managedMetaBaseUrl: relayBase},
    {repository: new AssistantRepository(db.database), ai: new AiRepository(db.database), instances, hermes, cipher, now, sleep});
    expect(await managed.configure(USER_ID, {provider: META_PROVIDER_ID, model: META_MODEL_ID, api_key: relayCredential})).toEqual({result: 'ok'});
    expect(instances.item('hermes-env')).toBe(`MODEL_API_KEY=${relayCredential}\nHERMES_API_TIMEOUT=300\nMETA_BASE_URL=${relayBase}\n`);
    expect(instances.item('hermes-config')).toBe(hermesConfig({mcp: MCP, model: {provider: META_PROVIDER_ID, model: META_MODEL_ID, baseUrl: relayBase}, timezone: null}));
    expect(instances.item('hermes-config')).not.toContain('https://api.meta.ai');
    expect(await dumpDb()).not.toContain(relayCredential);
  });

  it('O-10: configurar la IA conserva la exclusión por usuario de hermes-config', async () => {
    await seedAtConfigureAi();
    const saleadsExclude = (user: string) => user === USER_ID ? ['saleads_stock_take_photo'] : [];
    const ai = new AiConfigService({mcp: {...MCP, saleadsExclude}, deadlineMs: 85_000, ackTimeoutMs: 60_000, probeTimeoutMs: 45_000, pollIntervalMs: 2000, healthTimeoutMs: 3000},
      {repository: new AssistantRepository(db.database), ai: new AiRepository(db.database), instances, hermes, cipher, now: () => new Date(nowMs), sleep: async (ms: number) => {nowMs += ms;}});
    expect(await ai.configure(USER_ID, {provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1', api_key: 'sk-or-v1-synthetic-test-key-000000'})).toEqual({result: 'ok'});
    expect(instances.item('hermes-config')).toContain('      exclude: ["saleads_stock_take_photo"]\n');
  });

  it('GET /providers empieza con openai-api, anthropic, gemini y openrouter; todos con key y ninguno OAuth', async () => {
    const body = ProvidersResponseV1.parse((await request(app.getHttpServer())
      .get('/assistants/me/providers').set('Authorization', `Bearer ${token}`).expect(200)).body);
    expect(body.slice(0, 4).map(p => p.id)).toEqual(['openai-api', 'anthropic', 'gemini', 'openrouter']);
    expect(body.every(p => p.needs_key)).toBe(true);
    expect(body.map(p => p.id).filter(id => /oauth|codex|nous|copilot|bedrock|vertex/.test(id))).toEqual([]);
    expect(new Set(body.map(p => p.id)).size).toBe(body.length);
  });

  it('key válida: entrega la IA, espera el ack y el reinicio, prueba y deja status=ready', async () => {
    await seedAtConfigureAi();
    const before = createdVmItems();
    hermes.healthScript = [{kind: 'unreachable'}, NO_MODEL, HEALTHY];
    expect(await configure()).toBe('ok');

    // setMetadata con el fingerprint vigente y TODA la metadata: solo cambian hermes-env y hermes-config.
    expect(instances.sets).toHaveLength(1);
    expect(instances.sets[0]!.fingerprint).toBe('fp-0');
    for (const item of before.filter(i => !['hermes-env', 'hermes-config'].includes(i.key))) expect(instances.item(item.key)).toBe(item.value);
    expect(instances.item('hermes-env')).toBe(`OPENROUTER_API_KEY=${KEY}\nHERMES_API_TIMEOUT=300\nBRAIN_LLM_MODEL=${MODEL}\n`);
    expect(instances.item('hermes-config')).toContain('provider: "openrouter"');
    // Turno de prueba solo después de que Hermes volviera sano (3 lecturas de salud), por la IP privada.
    expect(hermes.probeCalls).toHaveLength(1);
    expect(hermes.probeCalls[0]!.target).toEqual({ip: VM_IP, apiServerKey: API_SERVER_KEY});
    expect(hermes.healthScript).toHaveLength(0);

    const finishedAt = nowMs;
    nowMs += 1000;
    expect(await me()).toMatchObject({status: 'ready', step: null, ai: {configured: true, provider: 'openrouter', model: MODEL},
      ready_since: new Date(finishedAt).toISOString()});
    expect(finishedAt - T0).toBeLessThan(85_000);
    expect((await events()).at(-1)).toMatchObject({kind: 'ai.configured', detail_safe: 'provider=openrouter result=ok reason=probe_ok'});
  });

  it('key inválida → invalid_key; el estado vuelve a «Configura tu IA» sin IA configurada', async () => {
    await seedAtConfigureAi();
    hermes.probes = [{kind: 'failed', text: REJECTED_KEY}];
    expect(await configure()).toBe('invalid_key');
    expect(await me()).toMatchObject({status: 'activating', step: 'configure_ai', ai: {configured: false, provider: null, model: null}});
    expect((await events()).at(-1)).toMatchObject({kind: 'ai.test_failed', cause_code: 'ai_test_failed'});
  });

  it('Meta requires the repaired watcher before changing any VM metadata', async () => {
    await seedAtConfigureAi();
    const original = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? String(MIN_META_WATCHER_VERSION - 1) : original(name, key);
    expect(await configure({provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe('unreachable');
    expect(instances.sets).toHaveLength(0);
    expect(hermes.probeCalls).toHaveLength(0);
    expect((await events()).at(-1)).toMatchObject({cause_code: 'config_apply_failed'});
  });

  it('Meta on the repaired watcher applies its environment and pins before a successful probe', async () => {
    await seedAtConfigureAi();
    const original = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? String(MIN_META_WATCHER_VERSION) : original(name, key);
    hermes.healthDefault = HEALTHY;
    hermes.probes = [{kind: 'completed'}];
    expect(await configure({provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe('ok');
    expect(instances.item('hermes-env')).toBe(`MODEL_API_KEY=${KEY}\nHERMES_API_TIMEOUT=300\n`);
    expect(instances.item('hermes-config')).toContain('default: "muse-spark-1.3-contributor"');
    expect(instances.item('hermes-config')).toContain('memory_query_rewrite:');
    expect(await me()).toMatchObject({status: 'ready', ai: {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID}});
  });

  it('Meta does not silently accept a different model than the owner selected', async () => {
    await seedAtConfigureAi();
    await put({provider: META_PROVIDER_ID, model: 'muse-spark-1.3', api_key: KEY}).expect(400);
    expect(instances.sets).toHaveLength(0);
  });

  it('modelo de menos de 64K o inexistente → incompatible_model; otro rechazo → provider_rejected', async () => {
    await seedAtConfigureAi();
    hermes.probes = [{kind: 'failed', text: SMALL_MODEL}];
    expect(await configure({model: 'meta/llama-3-8b'})).toBe('incompatible_model');
    hermes.probes = [{kind: 'failed', text: MISSING_MODEL}];
    expect(await configure({model: 'nope/model'})).toBe('incompatible_model');
    hermes.probes = [{kind: 'failed', text: BILLING}];
    expect(await configure()).toBe('provider_rejected');
  });

  it('key no cargada: 3 intentos y luego invalid_key', async () => {
    await seedAtConfigureAi();
    hermes.probes = [1, 2, 3].map(() => ({kind: 'failed' as const, text: 'No API key found for provider openrouter'}));
    expect(await configure()).toBe('invalid_key');
    expect(hermes.probeCalls).toHaveLength(3);
  });

  it('reemplazar la key: mismo PUT, sin recrear la VM ni reiniciar; la anterior no queda en hermes-env', async () => {
    await seedAtConfigureAi();
    expect(await configure()).toBe('ok');
    const healthReads = hermes.healthTargets.length;
    expect(await configure({api_key: NEW_KEY})).toBe('ok');
    expect(instances.item('hermes-env')).toBe(`OPENROUTER_API_KEY=${NEW_KEY}\nHERMES_API_TIMEOUT=300\nBRAIN_LLM_MODEL=${MODEL}\n`);
    expect(JSON.stringify(instances.view!.items)).not.toContain(KEY);
    // Misma config.yaml → no hay reinicio que esperar.
    expect(hermes.healthTargets.length).toBe(healthReads);
    expect(await me()).toMatchObject({status: 'ready', ai: {configured: true}});
  });

  it('cambiar de proveedor reemplaza la variable: solo queda la del nuevo', async () => {
    await seedAtConfigureAi();
    expect(await configure()).toBe('ok');
    expect(await configure({provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: NEW_KEY})).toBe('ok');
    expect(instances.item('hermes-env')).toBe(`ANTHROPIC_API_KEY=${NEW_KEY}\nHERMES_API_TIMEOUT=300\n`);
    expect(await me()).toMatchObject({ai: {provider: 'anthropic', model: 'claude-sonnet-4-5'}});
  });

  it('un 412 (otro escritor) relee el fingerprint y reintenta una vez', async () => {
    await seedAtConfigureAi();
    instances.conflictOnce = true;
    expect(await configure()).toBe('ok');
    expect(instances.sets).toHaveLength(2);
    expect(instances.sets[1]!.fingerprint).toBe('fp-1');
  });

  it('si el ack cambia por otra escritura (resiembra de tokens), relee la metadata y recalcula el esperado', async () => {
    await seedAtConfigureAi();
    instances.ackAfterPolls = null;
    const original = instances.setMetadata.bind(instances);
    instances.setMetadata = async (name, fingerprint, items) => {
      await original(name, fingerprint, items);
      // La renovación resiembra hermes-mcp-tokens justo después y el watcher aplica ambas juntas.
      const view = instances.view!;
      view.items = view.items.map(i => i.key === 'hermes-mcp-tokens' ? {...i, value: '{"tokens.json":{"access_token":"reseeded"}}'} : i);
      const combined = computeAppliedVersion(view.items);
      instances.guestAttribute = async () => combined;
    };
    expect(await configure()).toBe('ok');
  });

  it('sin ack del watcher → unreachable; el estado no cambia y queda la causa', async () => {
    await seedAtConfigureAi();
    instances.ackAfterPolls = null;
    expect(await configure()).toBe('unreachable');
    expect(hermes.probeCalls).toHaveLength(0);
    expect(await me()).toMatchObject({status: 'activating', step: 'configure_ai'});
    expect((await events()).at(-1)).toMatchObject({kind: 'ai.unreachable', cause_code: 'config_apply_failed', detail_safe: expect.stringContaining('reason=ack_timeout')});
    expect(nowMs - T0).toBeLessThanOrEqual(85_000);
  });

  it('Hermes no vuelve tras el reinicio o el turno no responde → unreachable dentro del plazo', async () => {
    await seedAtConfigureAi();
    hermes.healthDefault = {kind: 'unreachable'};
    expect(await configure()).toBe('unreachable');
    expect(nowMs - T0).toBeLessThanOrEqual(85_000);
    hermes.healthDefault = HEALTHY;
    hermes.probes = [{kind: 'unreachable', reason: 'timeout'}];
    expect(await configure({model: 'openai/gpt-4o'})).toBe('unreachable');
  });

  it('asistente aún instalándose o apagado → unreachable sin tocar la VM; sin asistente → 404', async () => {
    const missing = await put({provider: 'openrouter', model: MODEL, api_key: KEY}).expect(404);
    expect(ErrorResponseV1.parse(missing.body).code).toBe('NOT_FOUND');
    await seedAssistant(db.database, cipher, {userId: USER_ID, step: 'installing_agent', startedAt: new Date(T0)});
    expect(await configure()).toBe('unreachable');
    expect(instances.sets).toHaveLength(0);
  });

  it('valida la entrada: proveedor desconocido o modelo raro → 400; key con caracteres no válidos → invalid_key sin tocar la VM', async () => {
    await seedAtConfigureAi();
    expect(ErrorResponseV1.parse((await put({provider: 'nous', model: MODEL, api_key: KEY}).expect(400)).body).code).toBe('INVALID_REQUEST');
    await put({provider: 'openrouter', model: 'bad model\n', api_key: KEY}).expect(400);
    await put({provider: 'openrouter', model: MODEL, api_key: KEY, extra: true}).expect(400);
    expect(await configure({api_key: 'sk with spaces "and quotes"'})).toBe('invalid_key');
    expect(await configure({api_key: 'sk-abc\nOTHER=1'})).toBe('invalid_key');
    expect(instances.sets).toHaveLength(0);
  });

  it('la key no aparece en logs, base, eventos ni respuestas', async () => {
    await seedAtConfigureAi();
    hermes.probes = [{kind: 'failed', text: `${REJECTED_KEY} ${KEY}`}];
    const responses: string[] = [];
    responses.push(JSON.stringify((await put({provider: 'openrouter', model: MODEL, api_key: KEY})).body));
    responses.push(JSON.stringify((await put({provider: 'openrouter', model: MODEL, api_key: KEY})).body));
    responses.push(JSON.stringify((await put({provider: 'openrouter', model: 'bad model', api_key: KEY})).body));
    responses.push(JSON.stringify((await request(app.getHttpServer()).put('/assistants/me/ai').set('Authorization', `Bearer ${token}`)
      .set('content-type', 'application/json').send(`{"api_key":"${KEY}",`)).body));
    responses.push(JSON.stringify(await me()));
    const haystack = [logger.lines.join('\n'), await dumpDb(), responses.join('\n')].join('\n');
    expect(haystack).not.toContain(KEY);
    expect(haystack).not.toContain('SECRETKEY');
    expect(haystack).not.toContain(API_SERVER_KEY);
    expect(instances.item('hermes-api-key')).toBe(API_SERVER_KEY);
    expect(INSTANCE).toMatch(/^sa-assistant-/);
  });
});

describe('hermes-env: el cerebro usa el modelo del dueño', () => {
  const openrouter = {id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', verifiedInDev: true};
  it('con OpenRouter pasa el modelo al cerebro; con otro proveedor no', () => {
    expect(hermesEnv(openrouter, 'k', 'deepseek/deepseek-v4.1-flash')).toContain('BRAIN_LLM_MODEL=deepseek/deepseek-v4.1-flash\n');
    expect(hermesEnv({...openrouter, id: 'anthropic', envVar: 'ANTHROPIC_API_KEY'}, 'k', 'claude-x')).not.toContain('BRAIN_LLM_MODEL');
  });
  it('un modelo con saltos de línea nunca agrega otra variable', () => {
    expect(hermesEnv(openrouter, 'k', 'x\nAPI_SERVER_KEY=robada')).not.toContain('API_SERVER_KEY');
  });
});

describe('read-only managed Meta reconciliation', () => {
  const baseUrl = 'https://app.example.invalid/meta-inference/v1';
  const apiKey = 'synthetic-owner-bound-relay-key';
  const mcp = {mcpUrl: 'https://app.example.invalid/mcp', clientId: 'assistant', scope: 'openid'};
  const model = {provider: META_PROVIDER_ID, model: META_MODEL_ID, baseUrl};
  let row: AssistantRow;
  let instances: FakeInstances;
  let hermes: FakeHermes;
  let repository: AssistantRepository;
  let service: AiConfigService;
  let ack: string | null | undefined;

  beforeEach(() => {
    row = {status: 'ready', step: null, user_id: USER_ID, instance_name: INSTANCE, ai_configured: true,
      ai_provider: META_PROVIDER_ID, ai_model: META_MODEL_ID} as AssistantRow;
    instances = new FakeInstances();
    instances.view!.items.push({key: 'hermes-env', value: hermesEnv(findProvider(META_PROVIDER_ID)!, apiKey, META_MODEL_ID, baseUrl)});
    instances.view!.items.find(item => item.key === 'hermes-config')!.value = hermesConfig({mcp, model});
    ack = undefined;
    instances.guestAttribute = jest.fn(async (_name, key) => key === 'hermes/watcher-version'
      ? String(MIN_META_WATCHER_VERSION) : ack === undefined ? computeAppliedVersion(instances.view!.items) : ack);
    repository = {findActive: jest.fn(async () => row)} as unknown as AssistantRepository;
    hermes = new FakeHermes();
    service = new AiConfigService({mcp, managedMeta: {enabled: true, userId: USER_ID, allUsers: true}, managedMetaBaseUrl: baseUrl,
      deadlineMs: 1000, ackTimeoutMs: 1000, probeTimeoutMs: 1000, pollIntervalMs: 100, healthTimeoutMs: 1000},
    {repository, instances, hermes, ai: {} as AiRepository, cipher: new FieldCipher(Buffer.alloc(32, 9))});
  });

  it('restores durable success with the current owner credential and applied managed transport', async () => {
    expect(await service.reconcileManagedMeta(USER_ID, apiKey)).toBe('ready');
    expect(repository.findActive).toHaveBeenCalledWith(USER_ID);
    expect(instances.sets).toEqual([]);
    expect(hermes.probeCalls).toEqual([]);
  });

  it('preserves unrelated manual configuration and native integration variables', async () => {
    instances.view!.items.find(item => item.key === 'hermes-config')!.value +=
      'native_customization:\n  enabled: true\n';
    const config = instances.view!.items.find(item => item.key === 'hermes-config')!;
    config.value = config.value.replace('delegation:\n', 'delegation:\n  max_workers: 2\n');
    config.value = config.value.replace('auxiliary:\n', 'auxiliary:\n  native_auxiliary:\n    enabled: true\n');
    config.value = config.value.replace('  compression:\n', '  compression:\n    max_tokens: 512\n');
    instances.view!.items.find(item => item.key === 'hermes-env')!.value +=
      'TELEGRAM_BOT_TOKEN=synthetic-native-key\nTELEGRAM_BOT_TOKEN=updated-native-key\n';
    expect(await service.reconcileManagedMeta(USER_ID, apiKey)).toBe('ready');
    expect(instances.sets).toEqual([]);
  });

  it.each([
    ['unconfigured', () => {row.ai_configured = false;}],
    ['legacy provider', () => {row.ai_provider = 'openrouter';}],
    ['different model', () => {row.ai_model = 'different-model';}],
    ['another owner credential', () => {
      instances.view!.items.find(item => item.key === 'hermes-env')!.value =
        hermesEnv(findProvider(META_PROVIDER_ID)!, 'another-owner-relay-key', META_MODEL_ID, baseUrl);
    }],
    ['old direct transport', () => {
      instances.view!.items.find(item => item.key === 'hermes-config')!.value =
        hermesConfig({mcp, model: {provider: META_PROVIDER_ID, model: META_MODEL_ID}});
    }],
    ['old auxiliary transport', () => {
      const item = instances.view!.items.find(item => item.key === 'hermes-config')!;
      item.value = item.value.replace('    base_url: "' + baseUrl + '"', '    base_url: ""');
    }],
  ])('requires legitimate setup for %s', async (_name, change) => {
    change();
    expect(await service.reconcileManagedMeta(USER_ID, apiKey)).toBe('configure');
    expect(instances.sets).toEqual([]);
    expect(hermes.probeCalls).toEqual([]);
  });

  it('defers pending unrelated metadata without replaying setup', async () => {
    ack = 'old-ack-with-pending-native-assets';
    expect(await service.reconcileManagedMeta(USER_ID, apiKey)).toBe('deferred');
    expect(instances.sets).toEqual([]);
    expect(hermes.probeCalls).toEqual([]);
  });

  it('does not turn an unavailable watcher observation into a configuration write', async () => {
    instances.guestAttribute = async () => null;
    expect(await service.reconcileManagedMeta(USER_ID, apiKey)).toBe('deferred');
    expect(instances.sets).toEqual([]);
  });

  it('defers incomplete metadata observations for an already configured assistant', async () => {
    instances.view!.items = instances.view!.items.filter(item => item.key !== 'hermes-env');
    expect(await service.reconcileManagedMeta(USER_ID, apiKey)).toBe('deferred');
    expect(instances.sets).toEqual([]);
  });
});
