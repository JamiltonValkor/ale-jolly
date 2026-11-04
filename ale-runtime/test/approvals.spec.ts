import 'reflect-metadata';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {ApprovalsRepository, type ApprovalRow} from '../src/approvals/approvals-repository';
import {ApprovalsService, type ApprovalCatalog, type ApprovalExecutor} from '../src/approvals/approvals.service';
import {ApprovalV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const ITEM = {id: 'skill.beauty.seasonal', name: 'Promociones de temporada en belleza', version: '1.0.0', summary: 'Prepara campañas de temporada.'};

/** Catálogo de prueba: versión vigente por ítem; ítems desconocidos → null. */
class FakeCatalog implements ApprovalCatalog {
  versions = new Map<string, string>([[ITEM.id, ITEM.version]]);
  async resolve({itemId}: {itemId: string}) {
    const version = this.versions.get(itemId);
    return version ? {...ITEM, id: itemId, version} : null;
  }
}

class FakeExecutor implements ApprovalExecutor {
  constructor(readonly kind: ApprovalExecutor['kind'] = 'install_skill') {}
  runs: string[] = [];
  stale = false;
  fail = false;
  async isStale(): Promise<boolean> {return this.stale;}
  async execute(row: ApprovalRow): Promise<Record<string, unknown>> {
    this.runs.push(row.id);
    if (this.fail) throw new Error('boom');
    return {installed: row.item_id};
  }
}

describe('aprobaciones de instalación (OSB-013)', () => {
  let db: TestDatabase;
  let now: Date;
  let executor: FakeExecutor;
  let service: ApprovalsService;
  let catalog: FakeCatalog;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    await db.database.pool.query('DELETE FROM assistant.approvals');
    now = new Date('2026-10-29T12:00:00Z');
    executor = new FakeExecutor();
    catalog = new FakeCatalog();
    service = new ApprovalsService({repository: new ApprovalsRepository(db.database), catalog, executors: [executor], now: () => now});
  });

  const propose = (user = 'u1') => service.propose(user, {business_id: BUSINESS, kind: 'install_skill', item_id: ITEM.id});

  it('aprobar dos veces ejecuta una sola vez; la misma clave es idempotente', async () => {
    const approval = await propose();
    const first = await service.approve('u1', approval.id, 'key-aaaaaaaa');
    const again = await service.approve('u1', approval.id, 'key-aaaaaaaa');
    expect(first.status).toBe('executed');
    expect(again).toEqual(first);
    expect(executor.runs).toHaveLength(1);
    await expect(service.approve('u1', approval.id, 'key-bbbbbbbb')).rejects.toMatchObject({code: 'APPROVAL_ALREADY_DECIDED', status: 409});
  });

  it('un usuario ajeno recibe 404 y no ejecuta nada', async () => {
    const approval = await propose();
    await expect(service.get('u2', approval.id)).rejects.toMatchObject({code: 'NOT_FOUND', status: 404});
    await expect(service.approve('u2', approval.id, 'key-aaaaaaaa')).rejects.toMatchObject({code: 'NOT_FOUND'});
    expect(executor.runs).toEqual([]);
  });

  it('una pendiente vencida se lee como expired antes de que alguien intente decidir', async () => {
    const approval = await propose();
    now = new Date(now.getTime() + 25 * 3_600_000);
    expect((await service.get('u1', approval.id)).status).toBe('expired');
  });

  it('vencida da 410 y no ejecuta', async () => {
    const approval = await propose();
    now = new Date(now.getTime() + 25 * 3_600_000);
    await expect(service.approve('u1', approval.id, 'key-aaaaaaaa')).rejects.toMatchObject({code: 'APPROVAL_EXPIRED', status: 410});
    expect((await service.get('u1', approval.id)).status).toBe('expired');
    expect(executor.runs).toEqual([]);
  });

  it('si el ítem cambió de versión queda STALE (409) y no ejecuta', async () => {
    const approval = await propose();
    executor.stale = true;
    await expect(service.approve('u1', approval.id, 'key-aaaaaaaa')).rejects.toMatchObject({code: 'APPROVAL_STALE', status: 409});
    expect((await service.get('u1', approval.id)).status).toBe('stale');
    expect(executor.runs).toEqual([]);
  });

  it('un rechazo queda registrado y la misma propuesta no se vuelve a crear', async () => {
    const approval = await propose();
    expect((await service.reject('u1', approval.id, 'key-aaaaaaaa')).status).toBe('rejected');
    const again = await propose();
    expect(again.id).toBe(approval.id);
    expect(again.status).toBe('rejected');
    await expect(service.approve('u1', approval.id, 'key-bbbbbbbb')).rejects.toMatchObject({code: 'APPROVAL_ALREADY_DECIDED'});
  });

  it('una propuesta pendiente no se duplica; una nueva versión sí crea otra', async () => {
    const a = await propose();
    expect((await propose()).id).toBe(a.id);
    catalog.versions.set(ITEM.id, '1.1.0');
    const b = await propose();
    expect(b.id).not.toBe(a.id);
  });

  it('sin ejecutor para el tipo, aprobar responde 503 sin tomar la decisión', async () => {
    const approval = await service.propose('u1', {business_id: BUSINESS, kind: 'install_mcp', item_id: ITEM.id});
    await expect(service.approve('u1', approval.id, 'key-aaaaaaaa')).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE'});
    expect((await service.get('u1', approval.id)).status).toBe('pending');
  });

  it('un ítem que no está en el catálogo responde 404 y no crea nada', async () => {
    await expect(service.propose('u1', {business_id: BUSINESS, kind: 'install_skill', item_id: 'skill.unknown'})).rejects.toMatchObject({code: 'NOT_FOUND'});
  });

  it('si el ejecutor falla queda failed, sin datos privados', async () => {
    const approval = await propose();
    executor.fail = true;
    const result = await service.approve('u1', approval.id, 'key-aaaaaaaa');
    expect(result.status).toBe('failed');
  });
});

describe('HTTP de aprobaciones (OSB-013)', () => {
  let keys: TestKeys;
  let app: INestApplication;
  let db: TestDatabase;

  beforeAll(async () => {
    keys = await testKeys();
    db = await startTestDatabase();
    const executor = new FakeExecutor();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher: new FieldCipher(Buffer.alloc(32, 7)),
      approvals: new ApprovalsService({repository: new ApprovalsRepository(db.database), catalog: new FakeCatalog(), executors: [executor, new FakeExecutor('uninstall_skill')]}),
      internalApiToken: TOKEN,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
    await app.init();
  });
  afterAll(async () => {await app.close(); await db.close();});

  const internal = () => request(app.getHttpServer()).post('/internal/assistants/approvals');

  it('la ruta interna exige el token y un x-user-id válido', async () => {
    const body = {business_id: BUSINESS, kind: 'install_skill', item_id: ITEM.id};
    let res = await internal().send(body).expect(401);
    expect(ErrorResponseV1.parse(res.body).code).toBe('UNAUTHORIZED');
    res = await internal().set('x-internal-api-token', 'wrong-token-wrong-token-wrong-token-xx').set('x-user-id', USER_ID).send(body).expect(401);
    res = await internal().set('x-internal-api-token', TOKEN).send(body).expect(401);
    res = await internal().set('x-internal-api-token', TOKEN).set('x-user-id', USER_ID).send(body).expect(200);
    expect(ApprovalV1.parse(res.body).status).toBe('pending');
  });

  it('el dueño ve y aprueba con su sesión; la Idempotency-Key es obligatoria', async () => {
    const created = ApprovalV1.parse((await internal().set('x-internal-api-token', TOKEN).set('x-user-id', USER_ID)
      .send({business_id: BUSINESS, kind: 'uninstall_skill', item_id: ITEM.id}).expect(200)).body);
    const token = await keys.sign({});
    await request(app.getHttpServer()).get(`/assistants/approvals/${created.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const missingKey = await request(app.getHttpServer()).post(`/assistants/approvals/${created.id}/approve`).set('Authorization', `Bearer ${token}`).expect(400);
    expect(ErrorResponseV1.parse(missingKey.body).code).toBe('INVALID_REQUEST');
    const ok = await request(app.getHttpServer()).post(`/assistants/approvals/${created.id}/approve`)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'decision-0001').expect(200);
    expect(ApprovalV1.parse(ok.body).status).toBe('executed');
    const other = await request(app.getHttpServer()).post(`/assistants/approvals/${created.id}/approve`)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'decision-0002').expect(409);
    expect(ErrorResponseV1.parse(other.body).code).toBe('APPROVAL_ALREADY_DECIDED');
  });

  it('un id mal formado o ajeno responde 404', async () => {
    const token = await keys.sign({});
    await request(app.getHttpServer()).get('/assistants/approvals/not-a-uuid').set('Authorization', `Bearer ${token}`).expect(404);
    await request(app.getHttpServer()).get('/assistants/approvals/00000000-0000-4000-8000-0000000000ff').set('Authorization', `Bearer ${token}`).expect(404);
  });
});
