import 'reflect-metadata';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {BusinessProfileService, BusinessProfileStore, typeFromOffering} from '../src/business-profile/business-profile.service';
import {BusinessProfileV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import type {McpCallOutcome, McpToolClient} from '../src/orqa/mcp-client';
import type {AssistantEvent} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const PRODUCTS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOTH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_TOKEN = 'owner-access-token';

class FakeMcp implements McpToolClient {
  overview: McpCallOutcome = {ok: true, data: {businesses: [{business_id: PRODUCTS}, {business_id: BOTH}]}};
  profiles = new Map<string, McpCallOutcome>([
    [PRODUCTS, {ok: true, data: {business_id: PRODUCTS, offering_type: 'products'}}],
    [BOTH, {ok: true, data: {business_id: BOTH, offering_type: 'both'}}],
  ]);
  readonly calls: Array<{token: string; name: string}> = [];
  async call(token: string, name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    this.calls.push({token, name});
    if (name === 'saleads_get_account_overview') return this.overview;
    return this.profiles.get(String(args.business_id)) ?? {ok: false, code: 'MCP-E-NOT-FOUND'};
  }
}

describe('tipo de negocio (MLB-002)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let app: INestApplication;
  let mcp: FakeMcp;
  let token: string | null;
  let events: AssistantEvent[];
  let changed: string[];

  beforeAll(async () => {[db, keys] = await Promise.all([startTestDatabase(), testKeys()]);});
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.business_profiles', []);
    mcp = new FakeMcp();
    token = OWNER_TOKEN;
    events = [];
    changed = [];
    const service = new BusinessProfileService({toolTimeoutMs: 1_000}, {
      store: new BusinessProfileStore(db.database), mcp,
      accessToken: async () => token,
      repository: {appendEvent: async event => {events.push(event);}},
      onTypeChanged: userId => {changed.push(userId);},
      now: () => new Date('2027-10-19T15:00:00.000Z'),
    });
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: async () => true},
      cipher: new FieldCipher(Buffer.alloc(32, 7)),
      businessProfiles: service,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
    await app.init();
  });
  afterEach(async () => {await app.close();});

  const auth = async () => `Bearer ${await keys.sign()}`;
  const get = async (business: string, status: number) =>
    (await request(app.getHttpServer()).get(`/assistants/me/businesses/${business}/profile`).set('Authorization', await auth()).expect(status)).body;
  const put = async (business: string, body: object, status: number) =>
    (await request(app.getHttpServer()).put(`/assistants/me/businesses/${business}/profile`).set('Authorization', await auth())
      .set('Idempotency-Key', 'k-1').send(body).expect(status)).body;

  it('mapea offering_type de BI: products y services; both o vacío piden elegir', () => {
    expect(typeFromOffering('products')).toBe('physical_product');
    expect(typeFromOffering('services')).toBe('service');
    for (const value of ['both', undefined, null, '', 'infoproduct']) expect(typeFromOffering(value)).toBeNull();
  });

  it('un negocio de productos responde physical_product sin preguntar y sin guardar la precarga', async () => {
    const body = BusinessProfileV1.parse(await get(PRODUCTS, 200));
    expect(body).toEqual({business_id: PRODUCTS, business_type: 'physical_product', needs_choice: false, source: 'bi', updated_at: null});
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM assistant.business_profiles', [])).rows[0]).toEqual({n: 0});
    expect(mcp.calls.every(call => call.token === OWNER_TOKEN)).toBe(true);
  });

  it('con both la respuesta trae needs_choice', async () => {
    expect(BusinessProfileV1.parse(await get(BOTH, 200))).toMatchObject({business_type: null, needs_choice: true, source: null});
  });

  it('con la propiedad verificada pero el perfil caído responde 200 con needs_choice', async () => {
    mcp.profiles.set(PRODUCTS, {ok: false, code: 'mcp_unreachable'});
    expect(BusinessProfileV1.parse(await get(PRODUCTS, 200))).toMatchObject({business_type: null, needs_choice: true});
  });

  it('sin token del dueño o sin poder saber sus negocios responde 503, nunca 200', async () => {
    token = null;
    expect(ErrorResponseV1.parse(await get(PRODUCTS, 503)).code).toBe('SERVICE_UNAVAILABLE');
    expect(ErrorResponseV1.parse(await put(PRODUCTS, {business_type: 'service'}, 503)).code).toBe('SERVICE_UNAVAILABLE');
    token = OWNER_TOKEN;
    mcp.overview = {ok: false, code: 'mcp_unauthorized'};
    expect(ErrorResponseV1.parse(await get(PRODUCTS, 503)).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('un negocio ajeno o un id inválido responden 404 en GET y PUT', async () => {
    for (const business of [FOREIGN, 'not-a-uuid']) {
      expect(ErrorResponseV1.parse(await get(business, 404)).code).toBe('NOT_FOUND');
      expect(ErrorResponseV1.parse(await put(business, {business_type: 'service'}, 404)).code).toBe('NOT_FOUND');
    }
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM assistant.business_profiles', [])).rows[0]).toEqual({n: 0});
  });

  it('PUT guarda la elección del dueño; cambiar el tipo deja un evento y vence el bundle una sola vez', async () => {
    const saved = BusinessProfileV1.parse(await put(BOTH, {business_type: 'infoproduct'}, 200));
    expect(saved).toEqual({business_id: BOTH, business_type: 'infoproduct', needs_choice: false, source: 'owner', updated_at: '2027-10-19T15:00:00.000Z'});
    expect(BusinessProfileV1.parse(await get(BOTH, 200))).toEqual(saved);
    await put(BOTH, {business_type: 'infoproduct'}, 200);
    expect(events).toEqual([{userId: USER_ID, kind: 'business_profile.changed', phase: 'profile', detail: 'from=none to=infoproduct'}]);
    expect(changed).toEqual([USER_ID]);
  });

  it('PUT rechaza un tipo nulo, desconocido o campos de más', async () => {
    for (const body of [{business_type: null}, {business_type: 'retail'}, {business_type: 'service', extra: 1}, {}]) {
      expect(ErrorResponseV1.parse(await put(PRODUCTS, body, 400)).code).toBe('INVALID_REQUEST');
    }
  });
});
