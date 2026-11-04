import 'reflect-metadata';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {ErrorResponseV1, AssistantStateV1} from '../src/contracts/v1';
import {flagUnavailable} from '../src/domain/errors';
import type {AssistantFlag} from '../src/domain/ports';
import {configureApp} from '../src/http/configure-app';
import {Database} from '../src/persistence/database';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

describe('HTTP del servicio (esqueleto OCB-006)', () => {
  let keys: TestKeys;
  let app: INestApplication;
  let flag: jest.Mocked<AssistantFlag>;
  let query: jest.Mock;

  beforeAll(async () => {keys = await testKeys();});
  beforeEach(async () => {
    flag = {isEnabled: jest.fn().mockResolvedValue(true)};
    query = jest.fn().mockResolvedValue({rows: [{'?column?': 1}]});
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: new Database({query, end: jest.fn()} as unknown as Database['pool']),
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag,
      cipher: new FieldCipher(Buffer.alloc(32, 7)),
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
    await app.init();
  });
  afterEach(async () => {await app.close();});

  const expectError = (body: unknown, code: string) => {
    expect(ErrorResponseV1.parse(body).code).toBe(code);
  };

  it('GET /healthz responde 200 sin autenticación', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200, {status: 'ok'});
    expect(query).not.toHaveBeenCalled();
  });

  it('GET /readyz hace SELECT 1 y responde 503 si la base falla', async () => {
    await request(app.getHttpServer()).get('/readyz').expect(200, {status: 'ok'});
    expect(query).toHaveBeenCalledWith('SELECT 1');
    query.mockRejectedValueOnce(new Error('connection refused'));
    const response = await request(app.getHttpServer()).get('/readyz').expect(503);
    expectError(response.body, 'SERVICE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('refused');
  });

  it('una llamada sin token web válido recibe 401 y no consulta la bandera', async () => {
    const response = await request(app.getHttpServer()).get('/assistants/me').expect(401);
    expectError(response.body, 'UNAUTHORIZED');
    expect(response.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).get('/assistants/me').set('Authorization', 'Bearer x.y.z').expect(401);
    expect(flag.isEnabled).not.toHaveBeenCalled();
  });

  it('un token con azp=mcp-saleads-assistant-dev recibe 401', async () => {
    const token = await keys.sign({azp: 'mcp-saleads-assistant-dev'});
    const response = await request(app.getHttpServer()).get('/assistants/me').set('Authorization', `Bearer ${token}`).expect(401);
    expectError(response.body, 'UNAUTHORIZED');
  });

  it('un usuario sin bandera recibe 403; la bandera se consulta con su sub', async () => {
    flag.isEnabled.mockResolvedValue(false);
    const response = await request(app.getHttpServer()).get('/assistants/me')
      .set('Authorization', `Bearer ${await keys.sign()}`).expect(403);
    expectError(response.body, 'ASSISTANT_NOT_ENABLED');
    expect(flag.isEnabled).toHaveBeenCalledWith(USER_ID);
  });

  it('PostHog sin respuesta booleana → 503', async () => {
    flag.isEnabled.mockRejectedValue(flagUnavailable());
    const response = await request(app.getHttpServer()).get('/assistants/me')
      .set('Authorization', `Bearer ${await keys.sign()}`).expect(503);
    expectError(response.body, 'FLAG_UNAVAILABLE');
  });

  it('un token de `front` sin audiencia y con bandera pasa y recibe el estado v1', async () => {
    const response = await request(app.getHttpServer()).get('/assistants/me')
      .set('Authorization', `Bearer ${await keys.sign()}`).expect(200);
    expect(AssistantStateV1.parse(response.body)).toEqual({
      status: 'none', step: null, slow: false, session_id: null,
      ai: {configured: false, provider: null, model: null}, ready_since: null, timezone: null,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('una ruta desconocida responde 404 con el contrato de error', async () => {
    const response = await request(app.getHttpServer()).get('/nope').expect(404);
    expectError(response.body, 'NOT_FOUND');
  });
});
