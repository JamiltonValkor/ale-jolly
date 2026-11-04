import 'reflect-metadata';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {ApprovalsRepository} from '../src/approvals/approvals-repository';
import {ApprovalsService} from '../src/approvals/approvals.service';
import {MissingUserError, SaleadsServicesClient, type ServicesResponse} from '../src/approvals/saleads-services';
import {SpendActions, spendExecutors} from '../src/approvals/spend';
import {ApprovalCodeResponseV1, ApprovalV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const OTHER_BUSINESS = '00000000-0000-4000-8000-000000000099';
const PLAN = '00000000-0000-4000-8000-000000000020';
const CAMPAIGN = '00000000-0000-4000-8000-000000000040';

type Call = Parameters<SaleadsServicesClient['call']>[0];

/** strategy y campaign en memoria: responde como los endpoints reales que usa la web. */
class FakeServices {
  calls: Call[] = [];
  plan: Record<string, unknown> = {plan_id: PLAN, business_id: BUSINESS, name: 'Plan kit capilar', status: 'draft', updated_at: '2027-10-19T10:00:00Z'};
  campaign: Record<string, unknown> = {campaign_id: CAMPAIGN, business_id: BUSINESS, user_id: USER_ID, campaign_name: 'Kit mamás', status: 'active', updated_at: '2027-10-19T09:00:00Z'};
  pauseStatus = 200;
  patchBody: Record<string, unknown> = {success: true, plan: {plan_id: PLAN}};

  async call(input: Call): Promise<ServicesResponse> {
    this.calls.push(input);
    const ok = (body: Record<string, unknown>, status = 200, etag: string | null = null): ServicesResponse => ({status, body, etag});
    if (input.method === 'GET' && input.path === `/api/strategy/plan/${PLAN}`) return ok({plan: this.plan}, 200, `"${String(this.plan.updated_at)}"`);
    if (input.method === 'GET' && input.path === `/campaigns/${CAMPAIGN}`) return ok({success: true, data: {campaign: this.campaign}});
    if (input.method === 'POST' && input.path === `/api/strategy/plan/${PLAN}/launch`) return ok({status: 'launching'});
    if (input.method === 'POST' && input.path === `/campaigns/${CAMPAIGN}/pause`) {
      return this.pauseStatus === 409 ? ok({success: false, code: 'CAMPAIGN_ALREADY_PAUSED'}, 409) : ok({success: true});
    }
    if (input.method === 'POST' && input.path === `/campaigns/${CAMPAIGN}/resume`) return ok({success: false, code: 'CAMPAIGN_ALREADY_ACTIVE'}, 409);
    if (input.method === 'PATCH' && input.path === `/api/strategy/plan/${PLAN}`) return ok(this.patchBody);
    return ok({error: 'NOT_FOUND'}, 404);
  }
}

describe('aprobaciones de gasto con código (MLB-013)', () => {
  let db: TestDatabase;
  let now: Date;
  let services: FakeServices;
  let service: ApprovalsService;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    await db.database.pool.query('DELETE FROM assistant.approvals');
    now = new Date('2027-10-19T12:00:00Z');
    services = new FakeServices();
    const spend = new SpendActions(services as unknown as SaleadsServicesClient);
    service = new ApprovalsService({repository: new ApprovalsRepository(db.database), spend, executors: spendExecutors(spend), now: () => now});
  });

  const pause = () => service.propose(USER_ID, {business_id: BUSINESS, kind: 'pause_campaign', item_id: CAMPAIGN, params: {reason: 'Gasta sin vender'}});
  const sideEffects = () => services.calls.filter(c => c.method !== 'GET');

  it('pedir la misma pausa con otro motivo devuelve la aprobación pendiente, no una nueva', async () => {
    const first = await pause();
    const again = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'pause_campaign', item_id: CAMPAIGN, params: {reason: 'No vende tras el gasto mínimo'}});
    expect(again.id).toBe(first.id);
  });

  it('nada se ejecuta sin un código válido; el código correcto ejecuta una vez y se consume', async () => {
    const approval = await pause();
    expect(approval.details).toMatchObject({action: 'pause_campaign', reason: 'Gasta sin vender', code_required: true});
    expect(approval.item.name).toBe('Kit mamás');
    await expect(service.approve(USER_ID, approval.id, 'decision-0001')).rejects.toMatchObject({code: 'APPROVAL_CODE_INVALID'});
    const {code} = await service.requestCode(USER_ID, approval.id);
    await expect(service.approve(USER_ID, approval.id, 'decision-0001', '000000' === code ? '111111' : '000000')).rejects.toMatchObject({code: 'APPROVAL_CODE_INVALID'});
    expect(sideEffects()).toHaveLength(0);
    const done = await service.approve(USER_ID, approval.id, 'decision-0001', code);
    expect(done.status).toBe('executed');
    expect(done.details?.result).toMatchObject({action: 'pause_campaign', already: false});
    const [call] = sideEffects();
    expect(call).toMatchObject({method: 'POST', path: `/campaigns/${CAMPAIGN}/pause`, userId: USER_ID, body: {pause_reason: 'manual_user', reason_note: 'Gasta sin vender'}});
    // La misma clave devuelve lo decidido sin pedir de nuevo el código ni ejecutar otra vez.
    expect((await service.approve(USER_ID, approval.id, 'decision-0001')).status).toBe('executed');
    expect(sideEffects()).toHaveLength(1);
  });

  it('tres intentos fallidos agotan el código; un código vencido no sirve; como máximo 3 códigos', async () => {
    const approval = await pause();
    await service.requestCode(USER_ID, approval.id);
    for (const attempt of [1, 2]) {
      await expect(service.approve(USER_ID, approval.id, `decision-000${attempt}`, '999999')).rejects.toMatchObject({code: 'APPROVAL_CODE_INVALID'});
    }
    await expect(service.approve(USER_ID, approval.id, 'decision-0003', '999999')).rejects.toMatchObject({code: 'APPROVAL_CODE_ATTEMPTS'});
    const second = await service.requestCode(USER_ID, approval.id);
    now = new Date(now.getTime() + 6 * 60_000);
    await expect(service.approve(USER_ID, approval.id, 'decision-0004', second.code)).rejects.toMatchObject({code: 'APPROVAL_CODE_EXPIRED'});
    await service.requestCode(USER_ID, approval.id);
    await expect(service.requestCode(USER_ID, approval.id)).rejects.toMatchObject({code: 'APPROVAL_CODE_ATTEMPTS'});
    expect(sideEffects()).toHaveLength(0);
  });

  it('una aprobación vencida, rechazada o desactualizada no ejecuta nada; un plan editado deja el launch stale', async () => {
    const launch = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'launch_plan', item_id: PLAN});
    const {code} = await service.requestCode(USER_ID, launch.id);
    services.plan = {...services.plan, updated_at: '2027-10-19T11:30:00Z'};
    await expect(service.approve(USER_ID, launch.id, 'decision-0001', code)).rejects.toMatchObject({code: 'APPROVAL_STALE'});
    const rejected = await pause();
    await service.reject(USER_ID, rejected.id, 'decision-0002');
    await expect(service.requestCode(USER_ID, rejected.id)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    await db.database.pool.query('DELETE FROM assistant.approvals');
    const late = await pause();
    const lateCode = await service.requestCode(USER_ID, late.id);
    now = new Date(now.getTime() + 7 * 3_600_000);
    await expect(service.approve(USER_ID, late.id, 'decision-0003', lateCode.code)).rejects.toMatchObject({code: 'APPROVAL_CODE_EXPIRED'});
    expect(sideEffects()).toHaveLength(0);
  });

  it('«ya pausada» y «ya activa» dejan la aprobación executed', async () => {
    services.pauseStatus = 409;
    const approval = await pause();
    const {code} = await service.requestCode(USER_ID, approval.id);
    expect((await service.approve(USER_ID, approval.id, 'decision-0001', code)).details?.result).toMatchObject({already: true});
    const resume = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'resume_campaign', item_id: CAMPAIGN});
    const resumeCode = await service.requestCode(USER_ID, resume.id);
    const done = await service.approve(USER_ID, resume.id, 'decision-0002', resumeCode.code);
    expect(done.status).toBe('executed');
  });

  it('dos change_budget con montos distintos sobre la misma versión son dos aprobaciones; ejecuta con If-Match', async () => {
    const a = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'change_budget', item_id: PLAN, params: {monthly_budget: {amount: 600, currency: 'USD'}}});
    const b = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'change_budget', item_id: PLAN, params: {monthly_budget: {amount: 900, currency: 'USD'}}});
    const again = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'change_budget', item_id: PLAN, params: {monthly_budget: {amount: 600, currency: 'USD'}}});
    expect(a.id).not.toBe(b.id);
    expect(again.id).toBe(a.id);
    expect(a.item.version.length).toBeLessThanOrEqual(64);
    services.patchBody = {success: true, plan: {plan_id: '00000000-0000-4000-8000-000000000025'}};
    const {code} = await service.requestCode(USER_ID, a.id);
    const done = await service.approve(USER_ID, a.id, 'decision-0001', code);
    expect(done.details?.result).toMatchObject({action: 'change_budget', replaced_plan_id: '00000000-0000-4000-8000-000000000025'});
    expect(sideEffects()[0]).toMatchObject({method: 'PATCH', ifMatch: '"2027-10-19T10:00:00Z"', body: {monthly_budget: 600}, businessId: BUSINESS});
  });

  it('el recurso tiene que ser del negocio; un plan lanzado no cambia de presupuesto desde aquí', async () => {
    await expect(service.propose(USER_ID, {business_id: OTHER_BUSINESS, kind: 'launch_plan', item_id: PLAN})).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(service.propose(USER_ID, {business_id: OTHER_BUSINESS, kind: 'pause_campaign', item_id: CAMPAIGN, params: {reason: 'motivo'}}))
      .rejects.toMatchObject({code: 'NOT_FOUND'});
    services.plan = {...services.plan, status: 'launched'};
    await expect(service.propose(USER_ID, {business_id: BUSINESS, kind: 'change_budget', item_id: PLAN, params: {monthly_budget: {amount: 1, currency: 'USD'}}}))
      .rejects.toMatchObject({code: 'INVALID_REQUEST'});
  });

  it('el cliente interno rechaza cualquier llamada sin x-user-id', async () => {
    const client = new SaleadsServicesClient({strategyUrl: 'http://strategy.test', campaignUrl: 'http://campaign.test', timeoutMs: 1_000}, async () => {
      throw new Error('no debe llamar');
    });
    await expect(client.call({service: 'campaign', method: 'POST', path: `/campaigns/${CAMPAIGN}/pause`, userId: ''})).rejects.toBeInstanceOf(MissingUserError);
    const seen: Record<string, string>[] = [];
    const ok = new SaleadsServicesClient({strategyUrl: 'http://strategy.test', campaignUrl: 'http://campaign.test', timeoutMs: 1_000}, async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({'x-user-id': headers.get('x-user-id') ?? ''});
      return new Response('{}', {status: 200});
    });
    await ok.call({service: 'campaign', method: 'GET', path: `/campaigns/${CAMPAIGN}`, userId: USER_ID});
    expect(seen[0]?.['x-user-id']).toBe(USER_ID);
  });

  describe('HTTP', () => {
    let app: INestApplication;
    let keys: TestKeys;
    beforeAll(async () => {keys = await testKeys();});
    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
        database: db.database,
        identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
        flag: {isEnabled: async () => true},
        cipher: new FieldCipher(Buffer.alloc(32, 7)),
        approvals: service,
      })]}).compile();
      app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
      await app.init();
    });
    afterEach(async () => {await app.close();});

    it('pedir el código y aprobar con él; un código malo responde 422 APPROVAL_CODE_INVALID', async () => {
      const approval = await pause();
      const auth = `Bearer ${await keys.sign()}`;
      const issued = ApprovalCodeResponseV1.parse((await request(app.getHttpServer()).post(`/assistants/approvals/${approval.id}/code`)
        .set('Authorization', auth).expect(200)).body);
      expect(issued.delivery).toBe('simulated');
      const bad = await request(app.getHttpServer()).post(`/assistants/approvals/${approval.id}/approve`).set('Authorization', auth)
        .set('Idempotency-Key', 'decision-0009').send({code: issued.code === '123456' ? '654321' : '123456'}).expect(422);
      expect(ErrorResponseV1.parse(bad.body).code).toBe('APPROVAL_CODE_INVALID');
      const done = await request(app.getHttpServer()).post(`/assistants/approvals/${approval.id}/approve`).set('Authorization', auth)
        .set('Idempotency-Key', 'decision-0010').send({code: issued.code}).expect(200);
      expect(ApprovalV1.parse(done.body).status).toBe('executed');
    });
  });
});
