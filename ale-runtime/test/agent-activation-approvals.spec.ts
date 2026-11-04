import 'reflect-metadata';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {AgentActivationActions, agentActivationExecutor} from '../src/approvals/agent-activation';
import {AgentBudgetRepository} from '../src/approvals/agent-budget';
import {AgentBudgetService} from '../src/approvals/agent-budget.service';
import {ApprovalsRepository} from '../src/approvals/approvals-repository';
import {ApprovalsService} from '../src/approvals/approvals.service';
import {SaleadsServicesClient, type ServicesResponse} from '../src/approvals/saleads-services';
import {ApprovalV1, ApprovalVerificationV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const PUBLICATION = '0a720bbb-c1f4-4420-b340-a5670884bf07';
const CAMPAIGN = '2d94ab27-a131-5e4e-9ef7-af4d597c3e3e';
const AD_SET = '5b0e6f1e-1d7c-4c8e-9a51-1f3d6c2a9b10';
const BET = '277e5855-2c72-4cfb-8945-b78bbc6bae47';
const INTERNAL = 'x'.repeat(40);

type Call = Parameters<SaleadsServicesClient['call']>[0];

/** campaign-service (C-8 y activación) y subscription (cuota) en memoria. */
class FakeServices {
  calls: Call[] = [];
  updatedAt = '2027-08-16T02:00:00.000Z';
  state = 'awaiting_owner_approval';
  activationStatus = 200;
  reservation = 'reserved';
  onActivate?: () => Promise<void>;
  /** Proyección viva de integration (AAB-026): lo que agregaría encender hoy. */
  liveDelta = 300_000;
  integrationStatus = 200;

  async call(input: Call): Promise<ServicesResponse> {
    this.calls.push(input);
    const ok = (body: Record<string, unknown>, status = 200): ServicesResponse => ({status, body, etag: null});
    if (input.method === 'GET' && input.path === `/campaigns/internal/agent-v1/publications/${PUBLICATION}`) {
      return ok({success: true, data: {
        publication_id: PUBLICATION, business_id: BUSINESS, user_id: USER_ID, origin: 'agent', status: 'paused',
        agent_activation_state: this.state, updated_at: this.updatedAt, currency: 'COP',
        campaign: {campaign_id: CAMPAIGN, meta_campaign_id: '120251834225760053', name: '[Ale] Belleza', objective: 'OUTCOME_TRAFFIC', daily_budget: null, lifetime_budget: null},
        ad_sets: [{ad_set_id: AD_SET, name: '[Ale] Caja', daily_budget: 20000, lifetime_budget: null, targeting_summary: {geo: 'CO'}}],
        ads_count: 1, bet_ids: [BET], skill_ref: {skill_id: 'juan-estructura', skill_version: '1'}, agent_action_id: null,
      }});
    }
    if (input.method === 'POST' && input.path === `/campaigns/internal/agent-v1/publications/${PUBLICATION}/activation`) {
      await this.onActivate?.();
      if (this.activationStatus === 409) return ok({success: false, error: 'ACTIVATION_FAILED_ROLLED_BACK', data: {meta_error: {code: 100}}}, 409);
      return ok({success: true, data: {state: 'activated', campaign_id: CAMPAIGN}});
    }
    if (input.service === 'integration' && input.path === `/api/integration/internal/agentic/v1/meta/businesses/${BUSINESS}/agent-spend-projection`) {
      if (this.integrationStatus !== 200) return ok({success: false}, this.integrationStatus);
      return ok({success: true, data: {currency: 'COP', account_timezone: 'America/Bogota', period_start: '2027-07-27',
        spent_to_date_minor: 50_000, projected_active_minor: 100_000, requested_delta_minor: this.liveDelta}});
    }
    if (input.path === '/api/subscription/internal/quota-reservation-status') return ok({reservation_status: this.reservation});
    if (input.path === '/api/subscription/internal/commit-quota-reservation') {this.reservation = 'committed'; return ok({reservation_status: 'committed'});}
    if (input.path === '/api/subscription/internal/release-quota-reservation') {this.reservation = 'released'; return ok({reservation_status: 'released'});}
    return ok({error: 'NOT_FOUND'}, 404);
  }
}

describe('encender lo que publicó el agente (AAB-012, D21)', () => {
  let db: TestDatabase;
  let now: Date;
  let services: FakeServices;
  let budgets: AgentBudgetRepository;
  let service: ApprovalsService;
  const projection = {spent_to_date_minor: 50_000, projected_active_minor: 100_000, requested_delta_minor: 300_000, currency: 'COP'};

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  function build(enabled = true, liveProjection = false) {
    const agent = new AgentActivationActions(services as unknown as SaleadsServicesClient, budgets, {enabled, traceWriter: true, liveProjection, now: () => now});
    service = new ApprovalsService({repository: new ApprovalsRepository(db.database), agent, executors: [agentActivationExecutor(agent)], now: () => now});
  }

  beforeEach(async () => {
    await db.database.pool.query('DELETE FROM assistant.approvals');
    await db.database.pool.query('DELETE FROM assistant.agent_monthly_budgets');
    now = new Date('2027-08-16T12:00:00Z');
    services = new FakeServices();
    budgets = new AgentBudgetRepository(db.database);
    build();
  });

  const propose = () => service.propose(USER_ID, {business_id: BUSINESS, kind: 'activate_agent_publication', item_id: PUBLICATION, params: {projection}});
  const activations = () => services.calls.filter(call => call.path.endsWith('/activation'));
  const setBudget = (amountMinor: number) => budgets.set({businessId: BUSINESS, userId: USER_ID, amountMinor, currency: 'COP', periodStart: '2027-07-27', expectedRevision: null, now});

  it('C-31: con la bandera apagada no se puede proponer', async () => {
    build(false);
    await expect(propose()).rejects.toMatchObject({code: 'INVALID_REQUEST'});
  });

  it('propuesta: pendiente 24 h, sin código, todo leído de campaign-service; sin presupuesto ofrece subirlo al proyectado', async () => {
    const approval = ApprovalV1.parse(await propose());
    expect(approval.status).toBe('pending');
    expect(new Date(approval.expires_at).getTime() - now.getTime()).toBe(24 * 3_600_000);
    expect(approval.item).toMatchObject({id: PUBLICATION, name: '[Ale] Belleza'});
    expect(approval.details).toMatchObject({
      action: 'activate_agent_publication', code_required: false, publication_id: PUBLICATION, ads_count: 1,
      campaign: {campaign_id: CAMPAIGN, objective: 'OUTCOME_TRAFFIC'},
      ad_sets: [{ad_set_id: AD_SET, daily_budget: {amount: 20000, currency: 'COP'}, audience_summary: null}],
      bets: [{bet_id: BET, label: null, hypothesis: null}],
      budget: {monthly: null, exceeds: true, projected_with_activation: {amount: 450_000, currency: 'COP'}, proposed_monthly: {amount: 450_000, currency: 'COP'}},
    });
    // Otra proyección (el gasto avanzó) no abre otra aprobación de la misma publicación.
    const again = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'activate_agent_publication', item_id: PUBLICATION,
      params: {projection: {...projection, spent_to_date_minor: 60_000}}});
    expect(again.id).toBe(approval.id);
  });

  it('pedir código sobre este tipo es INVALID_REQUEST', async () => {
    const approval = await propose();
    await expect(service.requestCode(USER_ID, approval.id)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
  });

  it('aprobar sin código: sube el presupuesto que vio el dueño, enciende una vez y confirma la cuota; repetir no duplica', async () => {
    const approval = await propose();
    let seen: string | null = null;
    services.onActivate = async () => {seen = ApprovalVerificationV1.parse(await service.verification(USER_ID, approval.id)).status;};
    const done = await service.approve(USER_ID, approval.id, 'decision-0001');
    expect(done.status).toBe('executed');
    expect(seen).toBe('executing');
    expect(done.details?.result).toMatchObject({activated: true, budget_raised: true, quota: 'committed', strategy_approved: null});
    const budget = await budgets.current(BUSINESS);
    expect(budget).toMatchObject({revision: 1, currency: 'COP'});
    expect(Number(budget?.amount_minor)).toBe(450_000);
    const [call] = activations();
    // Margen 450.000 − 150.000 = 300.000 COP, bajo el mínimo de Meta: sin spend_cap (el respaldo es la evaluación).
    expect(call).toMatchObject({internal: true, businessId: BUSINESS, idempotencyKey: `approval:${approval.id}`});
    expect(call?.body).toEqual({approval_id: approval.id});
    expect(done.details?.result).toMatchObject({spend_cap_below_meta_minimum: true});
    expect((await service.approve(USER_ID, approval.id, 'decision-0001')).status).toBe('executed');
    await expect(service.approve(USER_ID, approval.id, 'decision-0002')).rejects.toMatchObject({code: 'APPROVAL_ALREADY_DECIDED'});
    expect(activations()).toHaveLength(1);
    expect(services.calls.filter(call => call.path.endsWith('commit-quota-reservation'))).toHaveLength(1);
  });

  it('T4: dentro del presupuesto no lo sube y manda el tope por campaña = margen del mes', async () => {
    await setBudget(1_000_000);
    const approval = await propose();
    expect(approval.details).toMatchObject({budget: {exceeds: false, proposed_monthly: null, monthly: {amount: 1_000_000, currency: 'COP'}}});
    const done = await service.approve(USER_ID, approval.id, 'decision-0003');
    expect(done.details?.result).toMatchObject({activated: true, budget_raised: false, spend_cap_below_meta_minimum: false});
    expect(activations()[0]?.body).toEqual({approval_id: approval.id, campaign_spend_cap_minor: 850_000});
    expect((await budgets.current(BUSINESS))?.revision).toBe(1);
  });

  it('si la publicación cambió y el agente vuelve a pedir: queda UNA aprobación pendiente, la nueva (dev E2E 2027-08-16)', async () => {
    const first = await propose();
    services.updatedAt = '2027-08-16T03:00:00.000Z';
    const second = await propose();
    expect(second.id).not.toBe(first.id);
    const {rows} = await db.database.pool.query(
      "SELECT id, status FROM assistant.approvals WHERE kind='activate_agent_publication' ORDER BY created_at", []);
    expect(rows).toEqual([{id: first.id, status: 'expired'}, {id: second.id, status: 'pending'}]);
  });

  it('si la publicación cambió entre la propuesta y la decisión: APPROVAL_STALE y no enciende', async () => {
    const approval = await propose();
    services.updatedAt = '2027-08-16T03:00:00.000Z';
    await expect(service.approve(USER_ID, approval.id, 'decision-0004')).rejects.toMatchObject({code: 'APPROVAL_STALE'});
    expect(activations()).toHaveLength(0);
  });

  it('si el encendido se revierte, la aprobación queda failed con su código y no hay segunda llamada', async () => {
    await setBudget(1_000_000);
    services.activationStatus = 409;
    const approval = await propose();
    const done = await service.approve(USER_ID, approval.id, 'decision-0005');
    expect(done.status).toBe('failed');
    expect(done.details?.result).toEqual({reason: 'execute_failed', code: 'ACTIVATION_FAILED_ROLLED_BACK'});
    expect((await service.approve(USER_ID, approval.id, 'decision-0005')).status).toBe('failed');
    expect(activations()).toHaveLength(1);
    expect(services.reservation).toBe('reserved');
  });

  it('si el dueño bajó el presupuesto después de la propuesta, no se enciende (BUDGET_EXCEEDED)', async () => {
    await setBudget(1_000_000);
    const approval = await propose();
    await budgets.set({businessId: BUSINESS, userId: USER_ID, amountMinor: 100_000, currency: 'COP', periodStart: '2027-07-27', expectedRevision: 1, now});
    const done = await service.approve(USER_ID, approval.id, 'decision-0006');
    expect(done.details?.result).toMatchObject({code: 'BUDGET_EXCEEDED'});
    expect(activations()).toHaveLength(0);
  });

  describe('proyección viva: lo que se enciende es lo que vio el dueño (corrida corta 3, Paola)', () => {
    beforeEach(() => build(true, true));
    const projectionCalls = () => services.calls.filter(call => call.service === 'integration');

    it('sin cambios enciende, y consulta integration con la publicación y el token interno', async () => {
      await setBudget(1_000_000);
      const approval = await propose();
      expect((await service.get(USER_ID, approval.id)).status).toBe('pending');
      expect((await service.approve(USER_ID, approval.id, 'decision-0030')).status).toBe('executed');
      expect(projectionCalls()[0]).toMatchObject({method: 'GET', internal: true, businessId: BUSINESS, query: {publication_id: PUBLICATION}});
    });

    it.each([
      ['el agente subió el presupuesto con el encendido pendiente', 600_000],
      ['el agente lo bajó', 100_000],
    ])('%s: el panel la ve vencida y aprobar es APPROVAL_STALE, sin encender', async (_label, liveDelta) => {
      await setBudget(1_000_000);
      const approval = await propose();
      services.liveDelta = liveDelta;
      expect((await service.get(USER_ID, approval.id)).status).toBe('stale');
      await expect(service.approve(USER_ID, approval.id, 'decision-0031')).rejects.toMatchObject({code: 'APPROVAL_STALE'});
      expect(activations()).toHaveLength(0);
    });

    it('al día siguiente, con los mismos presupuestos, no queda vencida (se compara el gasto diario)', async () => {
      await setBudget(1_000_000);
      const approval = await propose();
      now = new Date('2027-08-17T11:00:00Z');
      services.liveDelta = Math.round(300_000 * 10 / 11);
      expect((await service.get(USER_ID, approval.id)).status).toBe('pending');
      expect((await service.approve(USER_ID, approval.id, 'decision-0032')).status).toBe('executed');
    });

    it('sin integration no enciende (falla cerrado) y el panel la sigue mostrando pendiente', async () => {
      await setBudget(1_000_000);
      const approval = await propose();
      services.integrationStatus = 503;
      expect((await service.get(USER_ID, approval.id)).status).toBe('pending');
      await expect(service.approve(USER_ID, approval.id, 'decision-0033')).rejects.toBeTruthy();
      expect(activations()).toHaveLength(0);
    });
  });

  it('C-18: rechazar escribe approval_decided en la traza de la acción (writer assistant); sin acción no escribe', async () => {
    const actionId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    const withAction = await service.propose(USER_ID, {business_id: BUSINESS, kind: 'activate_agent_publication', item_id: PUBLICATION,
      params: {projection, agent_action_id: actionId}});
    await service.reject(USER_ID, withAction.id, 'decision-0020');
    const trace = services.calls.filter(call => call.path.includes('/agent-trace/'));
    expect(trace).toEqual([expect.objectContaining({path: `/campaigns/internal/agent-trace/v1/actions/${actionId}/steps`, internal: true, businessId: BUSINESS,
      body: expect.objectContaining({step_kind: 'approval_decided', writer: 'assistant', approval_id: withAction.id, action_state: 'rejected'})})]);
  });

  it('rechazar deja la publicación en pausa y libera la cuota una sola vez', async () => {
    const approval = await propose();
    expect((await service.reject(USER_ID, approval.id, 'decision-0007')).status).toBe('rejected');
    await service.reject(USER_ID, approval.id, 'decision-0007');
    expect(services.calls.filter(call => call.path.endsWith('release-quota-reservation'))).toHaveLength(1);
    expect(activations()).toHaveLength(0);
  });

  it('publicación que ya no está esperando aprobación: INVALID_REQUEST; verificación de otro usuario: 404', async () => {
    const approval = await propose();
    await expect(service.verification('otro-usuario', approval.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    services.state = 'activated';
    await service.reject(USER_ID, approval.id, 'decision-0008');
    await expect(propose()).rejects.toMatchObject({code: 'INVALID_REQUEST'});
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
        agentBudgets: new AgentBudgetService(budgets, async () => undefined, () => now),
        internalApiToken: INTERNAL,
      })]}).compile();
      app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
      await app.init();
    });
    afterEach(async () => {await app.close();});

    it('el dueño aprueba sin cuerpo; /code responde 400; la verificación interna lo ve ejecutado', async () => {
      const proposed = await request(app.getHttpServer()).post('/internal/assistants/approvals').set('x-internal-api-token', INTERNAL)
        .set('x-user-id', USER_ID).send({business_id: BUSINESS, kind: 'activate_agent_publication', item_id: PUBLICATION, params: {projection}}).expect(200);
      const id = ApprovalV1.parse(proposed.body).id;
      const auth = `Bearer ${await keys.sign()}`;
      const code = await request(app.getHttpServer()).post(`/assistants/approvals/${id}/code`).set('Authorization', auth).expect(400);
      expect(ErrorResponseV1.parse(code.body).code).toBe('INVALID_REQUEST');
      const done = await request(app.getHttpServer()).post(`/assistants/approvals/${id}/approve`).set('Authorization', auth)
        .set('Idempotency-Key', 'decision-0100').expect(200);
      expect(ApprovalV1.parse(done.body).status).toBe('executed');
      const verified = await request(app.getHttpServer()).get(`/internal/assistants/approvals/${id}/verification`)
        .set('x-internal-api-token', INTERNAL).set('x-user-id', USER_ID).expect(200);
      expect(ApprovalVerificationV1.parse(verified.body)).toMatchObject({approval_id: id, kind: 'activate_agent_publication', item_id: PUBLICATION, status: 'executed'});
    });

    it('MAN-001: un token del cliente del asistente (azp distinto de la web) no aprueba, no rechaza ni fija presupuesto', async () => {
      const approval = await propose();
      const vm = `Bearer ${await keys.sign({azp: 'mcp-saleads-assistant-dev'})}`;
      const server = app.getHttpServer();
      await request(server).post(`/assistants/approvals/${approval.id}/approve`).set('Authorization', vm).set('Idempotency-Key', 'decision-0101').expect(401);
      await request(server).post(`/assistants/approvals/${approval.id}/reject`).set('Authorization', vm).set('Idempotency-Key', 'decision-0102').expect(401);
      await request(server).post(`/assistants/approvals/${approval.id}/code`).set('Authorization', vm).expect(401);
      await request(server).put(`/assistants/me/businesses/${BUSINESS}/agent-budget`).set('Authorization', vm).set('If-Match', '*')
        .set('Idempotency-Key', 'budget-0101').send({amount: {amount: 500000, currency: 'COP'}}).expect(401);
      expect(activations()).toHaveLength(0);
    });

    it('ninguna ruta interna aprueba, rechaza ni escribe el presupuesto', () => {
      const routes: string[] = [];
      type Stack = {stack: Array<{route?: {path: string; methods: Record<string, boolean>}}>};
      const express = app.getHttpAdapter().getInstance() as {router?: Stack; _router?: Stack};
      for (const layer of (express.router ?? express._router)!.stack) {
        if (layer.route) routes.push(...Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${layer.route!.path}`));
      }
      const internal = routes.filter(route => route.includes('/internal/'));
      expect(internal.length).toBeGreaterThan(0);
      expect(internal.filter(route => /approve|reject|\/code$|^PUT .*agent-budget/.test(route))).toEqual([]);
    });
  });
});
