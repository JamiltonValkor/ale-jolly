import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {ActivationService} from '../src/activation/activation.service';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {Provisioner} from '../src/activation/provisioner';
import {AppModule} from '../src/app.module';
import {instanceNameFor, insertRequestId} from '../src/compute/instance-name';
import {computeAppliedVersion, HERMES_KEYS} from '../src/compute/metadata';
import {ActivationResponseV1, AssistantStateV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {OAuthFlowSecrets, pkceChallenge, sha256hex} from '../src/oauth/authorize';
import {OAuthTokenError, type AssistantTokenSet} from '../src/oauth/token-client';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {RowAssistantStateReader} from '../src/state/assistant-state';
import {FakeCompute, FakeTokens, TEMPLATE_ITEMS} from './support/fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const CLIENT_ID = 'mcp-saleads-assistant-dev';
const MCP_URL = 'https://dev.saleads.ai/mcp';
const REDIRECT = 'https://dev.saleads.ai/api/sales-assistant/oauth/callback';
const SCOPE = 'openid offline_access saleads-mcp saleads:read saleads:strategy saleads:campaigns saleads:launch saleads:events';
const OTHER_USER = '0a0b0c0d-2222-4333-8444-955566667777';
const MASTER_KEY = Buffer.alloc(32, 9);
const CODE = 'code-SECRET-4f1e9a7b';

/** Logger que captura todo lo que el servicio intentaría escribir. */
class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  debug(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  verbose(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

describe('activación en un clic (OCB-007)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let app: INestApplication;
  let repository: AssistantRepository;
  let compute: FakeCompute;
  let tokens: FakeTokens;
  let provisioner: Provisioner;
  let logger: CaptureLogger;
  let nowMs: number;
  const cipher = new FieldCipher(MASTER_KEY);
  const secrets = new OAuthFlowSecrets(MASTER_KEY);
  const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.1.0', 'saleads-sales-agent@1.1.0');

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    for (const sub of [USER_ID, OTHER_USER]) webTokens.set(sub, await keys.sign({sub, exp: Math.floor(Date.now() / 1000) + 3600}));
  });
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_credentials, assistant.oauth_flows, assistant.assistant_events', []);
    nowMs = Date.parse('2027-08-10T12:00:00.000Z');
    const now = () => new Date(nowMs);
    const sleep = async (ms: number) => {nowMs += ms;};
    repository = new AssistantRepository(db.database);
    compute = new FakeCompute();
    tokens = new FakeTokens();
    provisioner = new Provisioner({
      zone: 'us-central1-a', issuer: ISSUER, mcp: {mcpUrl: MCP_URL, clientId: CLIENT_ID, scope: SCOPE}, bundle,
      operationTimeoutMs: 60_000, retryDelayMs: 3_000, pollIntervalMs: 2_000,
    }, {repository, compute, tokens, cipher, now, sleep});
    const activation = new ActivationService({
      repository, cipher, secrets, tokens, provisioner, now, flowTtlMs: 600_000,
      assistantTokens: new IdentityVerifier({issuer: ISSUER, audience: MCP_URL, clients: [CLIENT_ID]}, keys.jwks),
      authorize: {authorizeUrl: `${ISSUER}/protocol/openid-connect/auth`, clientId: CLIENT_ID, redirectUri: REDIRECT, scope: SCOPE},
    });
    logger = new CaptureLogger();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher,
      stateReader: new RowAssistantStateReader(repository, now),
      activation,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.init();
  });
  afterEach(async () => {
    await provisioner.idle();
    await app.close();
  });

  const webTokens = new Map<string, string>();
  const web = (sub = USER_ID) => webTokens.get(sub)!;
  const assistantToken = (claims: Record<string, unknown> = {}) =>
    keys.sign({azp: CLIENT_ID, aud: ['https://dev.saleads.ai/mcp', 'account'], sub: USER_ID, ...claims});
  const tokenSet = async (claims: Record<string, unknown> = {}): Promise<AssistantTokenSet> => ({
    accessToken: await assistantToken(claims), refreshToken: `refresh-SECRET-${Math.random().toString(36).slice(2)}`,
    tokenType: 'Bearer', scope: SCOPE, expiresIn: 300,
  });
  const activate = (key = 'click-0001', sub = USER_ID) => request(app.getHttpServer())
    .post('/assistants/me/activation').set('Authorization', `Bearer ${web(sub)}`).set('Idempotency-Key', key);
  const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get('state')!;
  const callback = (body: unknown, sub = USER_ID) => request(app.getHttpServer())
    .post('/assistants/oauth/callback').set('Authorization', `Bearer ${web(sub)}`).send(body as object);
  const rows = async (sql: string, params: unknown[] = []) => (await db.database.pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  const events = async () => rows('SELECT kind, phase, cause_code, detail_safe FROM assistant.assistant_events ORDER BY id');
  const credentials = async () => rows('SELECT * FROM assistant.assistant_credentials');

  /** Activa y completa el callback del usuario con el token dado. */
  async function activateAndCallback(set?: AssistantTokenSet) {
    const first = await activate().expect(200);
    tokens.next = set ?? await tokenSet();
    await callback({code: CODE, state: stateOf(first.body.authorize_url)}).expect(200, {ok: true});
    await provisioner.idle();
    return first.body.authorize_url as string;
  }

  describe('POST /assistants/me/activation', () => {
    it('exige Idempotency-Key válida (400 con el contrato de error)', async () => {
      const response = await request(app.getHttpServer()).post('/assistants/me/activation')
        .set('Authorization', `Bearer ${web()}`).expect(400);
      expect(ErrorResponseV1.parse(response.body).code).toBe('INVALID_REQUEST');
      await activate('bad key!').expect(400);
      expect(await rows('SELECT * FROM assistant.assistants')).toHaveLength(0);
    });

    it('devuelve la authorize_url con PKCE S256, prompt=none, el cliente, el redirect y los scopes', async () => {
      const response = await activate().expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = ActivationResponseV1.parse(response.body) as {authorize_url: string};
      const url = new URL(body.authorize_url);
      expect(url.origin + url.pathname).toBe(`${ISSUER}/protocol/openid-connect/auth`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE,
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge: pkceChallenge(secrets.derive(USER_ID, 'click-0001').verifier),
        code_challenge_method: 'S256', prompt: 'none',
      });
      const [flow] = await rows('SELECT state_hash, user_id, expires_at FROM assistant.oauth_flows');
      expect(flow).toMatchObject({state_hash: sha256hex(url.searchParams.get('state')!), user_id: USER_ID});
      expect((flow!.expires_at as Date).getTime()).toBe(nowMs + 600_000);
      const [assistant] = await rows('SELECT status, step, attempts FROM assistant.assistants');
      expect(assistant).toEqual({status: 'activating', step: 'preparing_access', attempts: 0});
      expect((await events()).map(event => event.kind)).toEqual(['activation.started']);
    });

    it('es idempotente: el mismo clic repetido da la misma URL y un solo flujo; otro clic no crea otro asistente', async () => {
      const a = (await activate('click-0001').expect(200)).body.authorize_url;
      const b = (await activate('click-0001').expect(200)).body.authorize_url;
      const c = (await activate('click-0002').expect(200)).body.authorize_url;
      expect(b).toBe(a);
      expect(stateOf(c)).not.toBe(stateOf(a));
      expect(await rows('SELECT * FROM assistant.oauth_flows')).toHaveLength(2);
      expect(await rows('SELECT * FROM assistant.assistants')).toHaveLength(1);
      expect(compute.inserts).toHaveLength(0);
      // El mismo Idempotency-Key de otro usuario no comparte state.
      const other = (await activate('click-0001', OTHER_USER).expect(200)).body.authorize_url;
      expect(stateOf(other)).not.toBe(stateOf(a));
    });

    it('zona del navegador en el cuerpo (OCB-016): se guarda canónica y viaja en el hermes-config de la VM nueva', async () => {
      const first = await activate().send({timezone: 'america/mexico_city'}).expect(200);
      expect(first.body).toHaveProperty('authorize_url');
      expect(await rows('SELECT timezone FROM assistant.assistants')).toEqual([{timezone: 'America/Mexico_City'}]);
      tokens.next = await tokenSet();
      await callback({code: CODE, state: stateOf(first.body.authorize_url)}).expect(200, {ok: true});
      await provisioner.idle();
      const config = compute.inserts[0]!.items.find(item => item.key === 'hermes-config')!.value;
      expect(config).toContain('timezone: "America/Mexico_City"\n');
      // Con la VM ya creada, otra activación no cambia la zona (eso es PUT /timezone).
      const again = AssistantStateV1.parse((await activate('click-0002').send({timezone: 'Europe/Madrid'}).expect(200)).body);
      expect(again.timezone).toBe('America/Mexico_City');
      expect(await rows('SELECT timezone FROM assistant.assistants')).toEqual([{timezone: 'America/Mexico_City'}]);
    });

    it('zona inválida o campos extra en el cuerpo → 400 sin crear el asistente', async () => {
      for (const body of [{timezone: 'Mars/Olympus'}, {timezone: 'x'.repeat(65)}, {timezone: 'UTC', extra: 1}]) {
        const response = await activate().send(body).expect(400);
        expect(ErrorResponseV1.parse(response.body).code).toBe('INVALID_REQUEST');
      }
      expect(await rows('SELECT * FROM assistant.assistants')).toHaveLength(0);
    });

    it('con el asistente ya creado devuelve su estado y no crea flujo ni VM', async () => {
      await activateAndCallback();
      const response = await activate('click-0009').expect(200);
      expect(AssistantStateV1.parse(response.body)).toEqual({
        status: 'activating', step: 'preparing_environment', slow: false, session_id: null,
        ai: {configured: false, provider: null, model: null}, ready_since: null, timezone: null,
      });
      expect(compute.inserts).toHaveLength(1);
      expect(await rows('SELECT * FROM assistant.oauth_flows')).toHaveLength(0);
      const me = await request(app.getHttpServer()).get('/assistants/me').set('Authorization', `Bearer ${web()}`).expect(200);
      expect(me.body).toEqual(response.body);
    });

    it('una fila borrada (deleted_at) se reinicia y arranca un asistente nuevo', async () => {
      await activateAndCallback();
      await rows("UPDATE assistant.assistants SET status='ready', step=NULL, ready_since=now(), ai_configured=true, deleted_at=now()");
      const response = await activate('click-0010').expect(200);
      expect(response.body.authorize_url).toBeDefined();
      const [row] = await rows('SELECT status, step, instance_name, api_server_key_enc, ready_since, ai_configured, attempts, deleted_at FROM assistant.assistants');
      expect(row).toEqual({status: 'activating', step: 'preparing_access', instance_name: null, api_server_key_enc: null,
        ready_since: null, ai_configured: false, attempts: 0, deleted_at: null});
    });
  });

  describe('POST /assistants/oauth/callback', () => {
    it('provisions an isolated runtime without taking over the same owner legacy VM identity', async () => {
      const first = await activate().expect(200);
      const scoped = new Provisioner({
        zone: 'us-central1-a', runtimeNamespace: 'meta', issuer: ISSUER,
        mcp: {mcpUrl: MCP_URL, clientId: CLIENT_ID, scope: SCOPE}, bundle,
        operationTimeoutMs: 60_000, retryDelayMs: 3_000,
      }, {repository, compute, tokens, cipher, now: () => new Date(nowMs)});
      const scopedActivation = new ActivationService({
        repository, cipher, secrets, tokens, provisioner: scoped, now: () => new Date(nowMs), flowTtlMs: 600_000,
        assistantTokens: new IdentityVerifier({issuer: ISSUER, audience: MCP_URL, clients: [CLIENT_ID]}, keys.jwks),
        authorize: {authorizeUrl: `${ISSUER}/protocol/openid-connect/auth`, clientId: CLIENT_ID, redirectUri: REDIRECT, scope: SCOPE},
      });
      tokens.next = await tokenSet();
      await scopedActivation.callback(USER_ID, {code: CODE, state: stateOf(first.body.authorize_url)});
      await scoped.idle();
      expect(compute.inserts).toHaveLength(1);
      const insert = compute.inserts[0]!;
      expect(insert.name).toBe(instanceNameFor(USER_ID, 'meta'));
      expect(insert.name).not.toBe(instanceNameFor(USER_ID));
      expect(insert.requestId).toBe(insertRequestId(USER_ID, 1, nowMs, 'meta'));
      expect(insert.requestId).not.toBe(insertRequestId(USER_ID, 1, nowMs));
      const [row] = await rows('SELECT user_id, instance_name FROM assistant.assistants');
      expect(row).toEqual({user_id: USER_ID, instance_name: insert.name});
    });

    it('canjea, guarda el refresh cifrado con sub = usuario y crea UNA VM con la metadata fusionada', async () => {
      const set = await tokenSet();
      const url = await activateAndCallback(set);
      expect(tokens.exchanges).toEqual([{code: CODE, verifier: secrets.derive(USER_ID, 'click-0001').verifier}]);
      expect(await rows('SELECT * FROM assistant.oauth_flows')).toHaveLength(0);

      const [credential] = await credentials();
      expect(credential!.user_id).toBe(USER_ID);
      expect(Buffer.from(credential!.refresh_token_enc as Buffer).toString('utf8')).not.toContain(set.refreshToken);
      expect(cipher.open('assistant_credentials.refresh_token_enc', USER_ID, credential!.refresh_token_enc as Buffer)).toBe(set.refreshToken);

      expect(compute.inserts).toHaveLength(1);
      const insert = compute.inserts[0]!;
      expect(insert.name).toBe(instanceNameFor(USER_ID));
      expect(insert.name).toMatch(/^sa-assistant-[a-f0-9]{32}$/);
      expect(insert.requestId).toBe(insertRequestId(USER_ID, 1, Date.parse('2027-08-10T12:00:00.000Z')));
      const items = new Map(insert.items.map(item => [item.key, item.value]));
      // Todas las claves de la plantilla + las hermes-* (sin hermes-env ni archive hasta OCB-010/012).
      for (const item of TEMPLATE_ITEMS) expect(items.get(item.key)).toBe(item.value);
      expect(insert.items.map(item => item.key).filter(key => key.startsWith('hermes-')).sort()).toEqual(
        ['hermes-api-key', 'hermes-bundle-version', 'hermes-config', 'hermes-mcp-tokens', 'hermes-skills', 'hermes-soul']);
      expect(items.get('hermes-config')).toContain('url: "https://dev.saleads.ai/mcp"');
      expect(items.get('hermes-config')).toContain('client_id: "mcp-saleads-assistant-dev"');
      expect(items.get('hermes-config')).not.toMatch(/^model:/m);
      // Sin zona enviada: fallback America/Bogota (OCB-016).
      expect(items.get('hermes-config')).toContain('timezone: "America/Bogota"\n');
      expect(JSON.parse(items.get('hermes-mcp-tokens')!)).toEqual({'tokens.json': {
        access_token: set.accessToken, token_type: 'Bearer', refresh_token: set.refreshToken, scope: SCOPE,
        expires_at: Math.floor(Date.parse('2027-08-10T12:00:00.000Z') / 1000) + 300, hermes_issuer: ISSUER,
      }});
      expect(items.get('hermes-soul')).toBe(bundle.soul);
      expect(Object.keys(JSON.parse(items.get('hermes-skills')!))).toContain('saleads-human-decisions/SKILL.md');

      const [row] = await rows('SELECT * FROM assistant.assistants');
      expect(row).toMatchObject({status: 'activating', step: 'preparing_environment', instance_name: insert.name,
        zone: 'us-central1-a', bundle_version: 'saleads-sales-agent@1.1.0', attempts: 1});
      expect(cipher.open('assistants.api_server_key_enc', USER_ID, row!.api_server_key_enc as Buffer)).toBe(items.get('hermes-api-key'));
      expect(items.get('hermes-api-key')!.length).toBeGreaterThanOrEqual(16);
      expect((await events()).map(event => event.kind)).toEqual(['activation.started', 'oauth.completed', 'vm.create_requested']);
      expect(url).toContain('prompt=none');
    });

    it.each([
      ['state inválido', async () => ({code: CODE, state: 'x'.repeat(43)}), 'oauth.state_invalid'],
    ])('%s → 400 sin credencial y con evento oauth.*', async (_label, body, kind) => {
      await activate().expect(200);
      const response = await callback(await body()).expect(400);
      expect(ErrorResponseV1.parse(response.body).code).toBe('INVALID_REQUEST');
      expect(await credentials()).toHaveLength(0);
      expect(compute.inserts).toHaveLength(0);
      expect((await events()).at(-1)).toMatchObject({kind, cause_code: 'oauth_failed'});
    });

    it('state vencido → 400, sin canje ni credencial, evento oauth.state_expired', async () => {
      const url = (await activate().expect(200)).body.authorize_url;
      nowMs += 600_001;
      tokens.next = await tokenSet();
      await callback({code: CODE, state: stateOf(url)}).expect(400);
      expect(tokens.exchanges).toHaveLength(0);
      expect(await credentials()).toHaveLength(0);
      expect((await events()).at(-1)).toMatchObject({kind: 'oauth.state_expired', cause_code: 'oauth_failed'});
    });

    it('el state de otro usuario → 400, no se consume su flujo, evento oauth.user_mismatch', async () => {
      const url = (await activate('click-0001', OTHER_USER).expect(200)).body.authorize_url;
      await callback({code: CODE, state: stateOf(url)}, USER_ID).expect(400);
      expect(tokens.exchanges).toHaveLength(0);
      expect(await rows('SELECT user_id FROM assistant.oauth_flows')).toEqual([{user_id: OTHER_USER}]);
      expect((await events()).at(-1)).toMatchObject({kind: 'oauth.user_mismatch', cause_code: 'oauth_failed'});
    });

    it.each([
      ['sub distinto', {sub: OTHER_USER}, 'reason=sub_mismatch'],
      ['azp de otro cliente', {azp: 'front'}, 'reason=invalid_token'],
      ['sin audiencia del MCP', {aud: 'account'}, 'reason=invalid_token'],
    ])('token canjeado con %s → 400 sin credencial ni VM', async (_label, claims, detail) => {
      const url = (await activate().expect(200)).body.authorize_url;
      tokens.next = await tokenSet(claims);
      await callback({code: CODE, state: stateOf(url)}).expect(400);
      expect(await credentials()).toHaveLength(0);
      expect(compute.inserts).toHaveLength(0);
      expect((await events()).at(-1)).toMatchObject({kind: 'oauth.token_rejected', cause_code: 'oauth_failed', detail_safe: detail});
      const [row] = await rows('SELECT step FROM assistant.assistants');
      expect(row!.step).toBe('preparing_access');
    });

    it('Keycloak rechaza el código → 400; Keycloak caído → 503; ambos con evento y sin credencial', async () => {
      const a = (await activate('click-0001').expect(200)).body.authorize_url;
      tokens.next = new OAuthTokenError('rejected', 'invalid_grant');
      await callback({code: CODE, state: stateOf(a)}).expect(400);
      const b = (await activate('click-0002').expect(200)).body.authorize_url;
      tokens.next = new OAuthTokenError('unavailable', 'network');
      const response = await callback({code: CODE, state: stateOf(b)}).expect(503);
      expect(ErrorResponseV1.parse(response.body).code).toBe('SERVICE_UNAVAILABLE');
      expect(await credentials()).toHaveLength(0);
      expect((await events()).filter(event => event.kind === 'oauth.exchange_failed').map(event => event.detail_safe))
        .toEqual(['kind=rejected reason=invalid_grant', 'kind=unavailable reason=network']);
    });

    it('un body inválido → 400 sin tocar la base', async () => {
      await callback({code: CODE}).expect(400);
      await callback({code: CODE, state: 'x'.repeat(43), extra: 1}).expect(400);
      expect(await events()).toHaveLength(0);
    });
  });

  describe('creación de la VM', () => {
    it('dos callbacks concurrentes (dos clics) → un solo instances.insert', async () => {
      const a = (await activate('click-0001').expect(200)).body.authorize_url;
      const b = (await activate('click-0002').expect(200)).body.authorize_url;
      tokens.next = await tokenSet();
      await Promise.all([
        callback({code: CODE, state: stateOf(a)}).expect(200),
        callback({code: CODE, state: stateOf(b)}).expect(200),
      ]);
      await provisioner.idle();
      expect(compute.inserts).toHaveLength(1);
      expect(await credentials()).toHaveLength(1);
      expect((await events()).map(event => event.kind).sort()).toEqual(
        ['activation.started', 'oauth.completed', 'oauth.discarded', 'vm.create_requested']);
    });

    it('dos POST /activation simultáneos al reanudar (acceso concedido, sin VM) → un solo insert', async () => {
      const url = (await activate().expect(200)).body.authorize_url;
      tokens.next = await tokenSet();
      // El pod "muere" justo después del callback: el acceso queda concedido y la VM sin reclamar.
      jest.spyOn(provisioner, 'start').mockImplementationOnce(() => undefined);
      await callback({code: CODE, state: stateOf(url)}).expect(200);
      expect(compute.inserts).toHaveLength(0);
      (provisioner.start as jest.Mock).mockRestore();

      tokens.refreshed = await tokenSet();
      let release!: () => void;
      compute.insertDelay = () => new Promise<void>(resolve => {release = resolve;});
      const [r1, r2] = await Promise.all([activate('click-0003'), activate('click-0004')]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      while (!release) await new Promise(resolve => setImmediate(resolve));
      release();
      await provisioner.idle();
      expect(compute.inserts).toHaveLength(1);
      expect(tokens.refreshes).toHaveLength(1);
      // El refresh rotado reemplaza al guardado y viaja en mcp-tokens.
      const tokensItem = compute.inserts[0]!.items.find(item => item.key === 'hermes-mcp-tokens')!;
      expect(JSON.parse(tokensItem.value)['tokens.json'].refresh_token).toBe(tokens.refreshed.refreshToken);
      const [credential] = await credentials();
      expect(cipher.open('assistant_credentials.refresh_token_enc', USER_ID, credential!.refresh_token_enc as Buffer)).toBe(tokens.refreshed.refreshToken);
    });

    it('409 alreadyExists cuenta como creada: sin reintento ni fallo', async () => {
      compute.script = ['exists'];
      await activateAndCallback();
      expect(compute.inserts).toHaveLength(1);
      const [row] = await rows('SELECT status, attempts FROM assistant.assistants');
      expect(row).toEqual({status: 'activating', attempts: 1});
      expect((await events()).at(-1)).toMatchObject({kind: 'vm.create_requested', detail_safe: 'attempt=1 result=exists'});
    });

    it('un fallo reintenta UNA vez con otro requestId y queda creada', async () => {
      compute.script = [{status: 503, reason: 'backendError'}, 'ok'];
      await activateAndCallback();
      expect(compute.inserts.map(insert => insert.requestId)).toEqual([1, 2].map(attempt => insertRequestId(USER_ID, attempt, Date.parse('2027-08-10T12:00:00.000Z'))));
      expect(compute.inserts[1]!.items).toEqual(compute.inserts[0]!.items);
      const [row] = await rows('SELECT status, attempts FROM assistant.assistants');
      expect(row).toEqual({status: 'activating', attempts: 2});
      expect((await events()).slice(-2)).toEqual([
        {kind: 'vm.create_failed', phase: 'insert', cause_code: 'vm_create_failed', detail_safe: 'attempt=1 status=503 reason=backendError'},
        {kind: 'vm.create_requested', phase: 'insert', cause_code: null, detail_safe: 'attempt=2 result=created'},
      ]);
    });

    it('dos fallos → status=failed, causa en assistant_events y nada borrado', async () => {
      compute.script = [{operationError: 'ZONE_RESOURCE_POOL_EXHAUSTED'}, {status: 403, reason: 'forbidden'}];
      await activateAndCallback();
      expect(compute.inserts).toHaveLength(2);
      const [row] = await rows('SELECT status, step, instance_name, attempts, deleted_at FROM assistant.assistants');
      expect(row).toEqual({status: 'failed', step: 'preparing_environment', instance_name: instanceNameFor(USER_ID), attempts: 2, deleted_at: null});
      expect(await credentials()).toHaveLength(1);
      expect((await events()).slice(-3)).toEqual([
        {kind: 'vm.create_failed', phase: 'operation', cause_code: 'vm_create_failed', detail_safe: 'attempt=1 reason=ZONE_RESOURCE_POOL_EXHAUSTED'},
        {kind: 'vm.create_failed', phase: 'insert', cause_code: 'vm_create_failed', detail_safe: 'attempt=2 status=403 reason=forbidden'},
        {kind: 'activation.failed', phase: 'create_vm', cause_code: 'vm_create_failed', detail_safe: 'attempts=2'},
      ]);
      const me = await request(app.getHttpServer()).get('/assistants/me').set('Authorization', `Bearer ${web()}`).expect(200);
      expect(me.body).toMatchObject({status: 'failed', step: null});
      // Un clic nuevo no crea otra VM: devuelve el estado.
      await activate('click-0005').expect(200);
      expect(compute.inserts).toHaveLength(2);
    });

    it('una plantilla sin startup-script es un fallo de creación (nunca una VM sin watcher)', async () => {
      compute.template = TEMPLATE_ITEMS.filter(item => item.key !== 'startup-script');
      await activateAndCallback();
      expect(compute.inserts).toHaveLength(0);
      expect((await events()).filter(event => event.kind === 'vm.create_failed').map(event => event.detail_safe))
        .toEqual(['attempt=1 reason=template_without_startup_script', 'attempt=2 reason=template_without_startup_script']);
    });

    it('una operación que no termina a tiempo no se reintenta (la VM sigue creándose)', async () => {
      compute.script = ['pending'];
      await activateAndCallback();
      expect(compute.inserts).toHaveLength(1);
      expect((await events()).at(-1)).toMatchObject({kind: 'vm.create_requested', detail_safe: 'attempt=1 result=pending'});
    });

    it('slow=true tras 5 minutos sin llegar a configure_ai', async () => {
      await activateAndCallback();
      nowMs += 5 * 60_000 + 1;
      const me = await request(app.getHttpServer()).get('/assistants/me').set('Authorization', `Bearer ${web()}`).expect(200);
      expect(me.body).toMatchObject({status: 'activating', step: 'preparing_environment', slow: true});
    });
  });

  it('los logs y los eventos nunca llevan code, state, verifier, tokens, API_SERVER_KEY ni valores de metadata', async () => {
    const stdout = jest.spyOn(process.stdout, 'write');
    const stderr = jest.spyOn(process.stderr, 'write');
    try {
      compute.script = [{status: 500, reason: 'internalError'}, 'ok'];
      const set = await tokenSet();
      const url = await activateAndCallback(set);
      // Fallos OAuth también registrados.
      await callback({code: CODE, state: stateOf(url)}).expect(400);
      tokens.next = new OAuthTokenError('rejected', 'invalid_grant');
      const again = (await activate('click-0099', OTHER_USER).expect(200)).body.authorize_url;
      await callback({code: CODE, state: stateOf(again)}, OTHER_USER).expect(400);

      const items = new Map(compute.inserts[0]!.items.map(item => [item.key, item.value]));
      const flow = secrets.derive(USER_ID, 'click-0001');
      const secretsToFind = [
        CODE, flow.state, flow.verifier, stateOf(again), set.accessToken, set.refreshToken, 'eyJ',
        ...HERMES_KEYS.map(key => items.get(key)).filter((value): value is string => !!value)
          .flatMap(value => [value, value.slice(0, 40)]),
      ];
      const written = [
        ...logger.lines,
        ...stdout.mock.calls.map(call => String(call[0])),
        ...stderr.mock.calls.map(call => String(call[0])),
        JSON.stringify(await events()),
      ].join('\n');
      expect(logger.lines.length).toBeGreaterThan(0);
      for (const secret of secretsToFind) expect(written).not.toContain(secret);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('el ack esperado de la VM se calcula sobre la metadata enviada', async () => {
    await activateAndCallback();
    const ack = computeAppliedVersion(compute.inserts[0]!.items);
    expect(ack).toMatch(/^[a-f0-9]{64}$/);
    // Las claves de la plantilla no cuentan.
    expect(computeAppliedVersion(compute.inserts[0]!.items.filter(item => item.key.startsWith('hermes-')))).toBe(ack);
  });
});
