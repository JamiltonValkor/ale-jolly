import 'reflect-metadata';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {META_MODEL_ID, META_PROVIDER_ID} from '../src/ai/meta-model';
import type {TrustedContextV1} from '../src/contracts/continuous-loop';
import {FirstLoopRepository} from '../src/first-loop/repository';
import {FirstLoopService, type FirstLoopDeps} from '../src/first-loop/service';
import type {HermesTarget} from '../src/hermes/hermes-client';
import {configureApp} from '../src/http/configure-app';
import {LanguagePreferences} from '../src/locale/preferences';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, type TestKeys} from './support/tokens';

const OWNER_A = 'independent-owner-a', OWNER_B = 'independent-owner-b';
const BUSINESS_A = '11111111-1111-4111-8111-111111111111', BUSINESS_B = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

describe('managed Meta all-account identity and continuous loop', () => {
  let pg: TestDatabase, keys: TestKeys, app: INestApplication, service: FirstLoopService;
  let repository: FirstLoopRepository, languages: LanguagePreferences, deps: FirstLoopDeps;
  const cipher = new FieldCipher(Buffer.alloc(32, 19));
  const rows = new Map<string, AssistantRow>();
  const bootstrap = jest.fn(async (owner: string, business: string) => ({verified_owner: owner, business_id: business}));
  const publishContext = jest.fn(async (_row: AssistantRow, _context: TrustedContextV1) => undefined);
  const synchronizeJobs = jest.fn(async (_row: AssistantRow, _context: TrustedContextV1, _target: HermesTarget) => undefined);
  const languageChanged = jest.fn(async (_row: AssistantRow, _preference: unknown) => undefined);
  const signedPutUrl = jest.fn(async (object: string) => 'https://storage.example.invalid/' + object);
  const download = jest.fn(async (_object: string) => null);
  const start = jest.fn(async (_target: HermesTarget, _session: string, _text: string, _instructions: string, key: string) => ({run_id: key, status: 'queued'}));
  const flag = {isEnabled: jest.fn(async (user: string) => rows.has(user))};

  beforeAll(async () => {
    [pg, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    repository = new FirstLoopRepository(pg.database, cipher);
    languages = new LanguagePreferences(pg.database);
    for (const [index, owner] of [OWNER_A, OWNER_B].entries()) rows.set(owner, {
      user_id: owner, status: 'ready', ai_configured: true, ai_provider: META_PROVIDER_ID, ai_model: META_MODEL_ID,
      private_ip: '10.0.0.' + (index + 1), instance_name: 'vm-' + owner,
      api_server_key_enc: cipher.seal('assistants.api_server_key_enc', owner, 'runtime-key-' + owner),
    } as AssistantRow);
    deps = {
      repository, languages, cipher, assistants: {findActive: async user => rows.get(user) ?? null},
      ownedBusinesses: async user => new Set(user === OWNER_A ? [BUSINESS_A] : user === OWNER_B ? [BUSINESS_B] : []),
      bootstrap, publishContext, synchronizeJobs, languageChanged,
      hermes: {ensureSession: async () => ({kind: 'ok'}), messages: async () => ({kind: 'ok', messages: []})} as never,
      runs: {start, status: async () => 'completed', capabilities: async () => ({supported: true, durable: true, retention_seconds: 86400})},
      instances: {getInstance: async () => ({fingerprint: 'fixture', items: []}), setMetadata: async () => undefined} as never,
      storage: {signedPutUrl, download, upload: async () => undefined},
    };
    const scope = {enabled: true, userId: OWNER_A, allUsers: true};
    service = new FirstLoopService({...scope, continuousLearning: true}, deps);
    const module = await Test.createTestingModule({imports: [AppModule.register({
      database: pg.database, cipher, firstLoop: service, managedMeta: scope, flag,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
    })]}).compile();
    app = configureApp(module.createNestApplication({bodyParser: false, logger: false}));
    await app.init();
  });
  afterAll(async () => {await service.idle(); await app.close(); await pg.close();});
  const path = (business: string) => '/assistants/me/businesses/' + business + '/first-loop';
  const auth = async (owner: string) => 'Bearer ' + await keys.sign({sub: owner});

  it('preserves authentication and feature-flag denial for unknown or anonymous callers', async () => {
    for (const route of ['/assistants/me/providers', path(BUSINESS_B), '/assistants/me/preferences/language']) {
      const anonymous = route.endsWith('/language') ? request(app.getHttpServer()).put(route).send({}) : request(app.getHttpServer()).get(route);
      await anonymous.expect(401);
    }
    expect(flag.isEnabled).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get(path(BUSINESS_B)).set('Authorization', await auth('unknown-account')).expect(403);
    expect(flag.isEnabled).toHaveBeenLastCalledWith('unknown-account');
    expect(start).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    await expect(service.state('', BUSINESS_B)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(service.state('unknown-account', BUSINESS_B)).rejects.toMatchObject({code: 'NOT_FOUND'});
  });

  it('opens normal chat, bootstrap, locale and managed jobs separately for two unrelated accounts', async () => {
    const flows: string[] = [], sessions: string[] = [];
    for (const [owner, business, locale] of [[OWNER_A, BUSINESS_A, 'en'], [OWNER_B, BUSINESS_B, 'pt']] as const) {
      const authorization = await auth(owner);
      await request(app.getHttpServer()).get('/assistants/me/providers').set('Authorization', authorization)
        .expect(200, [{id: META_PROVIDER_ID, label: 'Meta Model API', needs_key: false}]);
      await request(app.getHttpServer()).put('/assistants/me/ai').set('Authorization', authorization).send({provider: 'openrouter'}).expect(400);
      await request(app.getHttpServer()).put('/assistants/me/preferences/language').set('Authorization', authorization)
        .send({language_code: locale, source_updated_at: '2026-10-29T10:00:00Z'}).expect(200);
      const response = await request(app.getHttpServer()).get(path(business)).set('Authorization', authorization).expect(200);
      await service.idle();
      flows.push(response.body.flow_id); sessions.push(response.body.session_id);
      expect(response.body.response_locale).toBe(locale);
      expect(bootstrap).toHaveBeenCalledWith(owner, business);
      expect(synchronizeJobs).toHaveBeenCalledWith(rows.get(owner), expect.objectContaining({owner_id: owner, business_id: business, response_locale: locale}),
        {ip: rows.get(owner)!.private_ip, apiServerKey: 'runtime-key-' + owner});
      expect(publishContext).toHaveBeenCalledWith(rows.get(owner), expect.objectContaining({owner_id: owner, business_id: business, session_id: response.body.session_id}));
      const turn = (await repository.turns(response.body.flow_id))[0]!;
      const payload = repository.payload(turn);
      expect(payload.text).toContain('guided-first-use/3');
      expect(payload.text).toContain(JSON.stringify({verified_owner: owner, business_id: business}));
      expect(payload.instructions).toContain('response_locale=' + locale);
      expect(start).toHaveBeenCalledWith({ip: rows.get(owner)!.private_ip, apiServerKey: 'runtime-key-' + owner}, response.body.session_id,
        payload.text, payload.instructions, expect.any(String));
      await service.message(owner, business, {flow_id: response.body.flow_id, client_message_id: CLIENT, text: 'Message from ' + owner, response_locale: locale});
      await service.idle();
      expect(signedPutUrl).toHaveBeenCalledWith('first-loop-uploads/' + owner + '/snapshot.json.gz', expect.any(Date), 604800);
      expect(download).toHaveBeenCalledWith('first-loop-uploads/' + owner + '/snapshot.json.gz', 8388608);
    }
    expect(new Set(flows).size).toBe(2); expect(new Set(sessions).size).toBe(2);
    for (const [owner, business] of [[OWNER_A, BUSINESS_A], [OWNER_B, BUSINESS_B]]) {
      const flow = (await repository.flow(owner!, business!))!;
      const message = (await repository.turn(flow.id, CLIENT))!;
      expect(repository.payload(message).owner_text).toBe('Message from ' + owner);
    }
    expect(await repository.flow(OWNER_B, BUSINESS_A)).toBeNull();
    expect(() => cipher.open('assistants.api_server_key_enc', OWNER_B, rows.get(OWNER_A)!.api_server_key_enc!)).toThrow();
  });

  it('keeps business/flow ownership and language revisions isolated after admission', async () => {
    const before = start.mock.calls.length;
    await request(app.getHttpServer()).get(path(BUSINESS_A)).set('Authorization', await auth(OWNER_B)).expect(404);
    const flowA = (await repository.flow(OWNER_A, BUSINESS_A))!;
    await expect(service.message(OWNER_B, BUSINESS_B, {flow_id: flowA.id, client_message_id: CLIENT, text: 'Cross-account request', response_locale: 'pt'}))
      .rejects.toMatchObject({code: 'NOT_FOUND'});
    expect(start).toHaveBeenCalledTimes(before);
    await service.synchronizeLanguage(OWNER_B, {language_code: 'fr', source_updated_at: '2026-10-29T11:00:00Z'});
    expect(await languages.require(OWNER_B)).toMatchObject({response_locale: 'fr', locale_revision: 2});
    expect(await languages.require(OWNER_A)).toMatchObject({response_locale: 'en', locale_revision: 1});
    expect(languageChanged).toHaveBeenLastCalledWith(rows.get(OWNER_B), expect.objectContaining({response_locale: 'fr'}));
    const pilot = new FirstLoopService({enabled: true, userId: OWNER_A, continuousLearning: true}, deps);
    await expect(pilot.state(OWNER_B, BUSINESS_B)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(pilot.synchronizeLanguage(OWNER_B, {language_code: 'en', source_updated_at: '2026-10-29T12:00:00Z'})).rejects.toMatchObject({code: 'NOT_FOUND'});
    const disabled = new FirstLoopService({enabled: false, userId: OWNER_A, allUsers: true}, deps);
    await expect(disabled.state(OWNER_B, BUSINESS_B)).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE'});
  });

  it('robot context follows the web-selected business, its canonical session and never a foreign business', async () => {
    const robot = (selected: string | null) => new FirstLoopService({enabled: true, userId: OWNER_A, allUsers: true, continuousLearning: true},
      {...deps, selectedBusiness: async () => selected});
    const flow = await repository.flow(OWNER_A, BUSINESS_A);
    publishContext.mockClear();
    const context = await robot(BUSINESS_A).deviceContext(OWNER_A);
    expect(context?.session_id).toBe(flow!.session_id);
    expect(context?.instructions).toContain(BUSINESS_A);
    expect(publishContext).toHaveBeenCalledWith(rows.get(OWNER_A), expect.objectContaining({business_id: BUSINESS_A, session_id: flow!.session_id}));
    await expect(robot(BUSINESS_B).deviceContext(OWNER_A)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(robot(null).deviceContext(OWNER_A)).resolves.toBeNull();
  });
});
