import {AgentBudgetRepository, budgetPeriod, evaluateAgentBudget, toMajor, toMinor} from '../src/approvals/agent-budget';
import {AgentBudgetService} from '../src/approvals/agent-budget.service';
import {AgentMonthlyBudgetV1} from '../src/contracts/v1';
import {notFound} from '../src/domain/errors';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {USER_ID} from './support/tokens';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const FOREIGN = '00000000-0000-4000-8000-000000000099';
const base = {currency: 'COP', spent_to_date_minor: 100_000, projected_active_minor: 300_000, requested_delta_minor: 100_000};

describe('evaluación del presupuesto mensual del agente (AAB-012, D13, D23)', () => {
  const budget = (amount_minor: number, currency = 'COP') => ({amount_minor, currency, revision: 3});

  it('within con el borde exacto; exceeds por un peso; no_budget sin fila vigente', () => {
    expect(evaluateAgentBudget(budget(500_000), base)).toMatchObject({decision: 'within', remaining_minor: 0, projected_minor: 500_000, revision: 3});
    expect(evaluateAgentBudget(budget(499_999), base)).toMatchObject({decision: 'exceeds', remaining_minor: -1});
    expect(evaluateAgentBudget(null, base)).toMatchObject({decision: 'no_budget', monthly_minor: null, campaign_spend_cap_minor: null});
  });

  it('otra moneda que la del presupuesto: exceeds con CURRENCY_MISMATCH', () => {
    expect(evaluateAgentBudget(budget(10_000_000, 'USD'), base)).toMatchObject({decision: 'exceeds', code: 'CURRENCY_MISMATCH', campaign_spend_cap_minor: null});
  });

  it('T4: tope por campaña = gastado de la campaña + margen del mes; bajo el mínimo de Meta no se sube al mínimo', () => {
    expect(evaluateAgentBudget(budget(2_000_000), {...base, campaign_spent_minor: 10_000}))
      .toMatchObject({campaign_spend_cap_minor: 1_610_000, spend_cap_below_meta_minimum: false});
    expect(evaluateAgentBudget(budget(600_000), base)).toMatchObject({campaign_spend_cap_minor: null, spend_cap_below_meta_minimum: true});
    expect(evaluateAgentBudget(budget(100_000), base)).toMatchObject({campaign_spend_cap_minor: null});
    expect(evaluateAgentBudget({amount_minor: 5_000_000, currency: 'GTQ', revision: 1}, {...base, currency: 'GTQ'}))
      .toMatchObject({campaign_spend_cap_minor: null, spend_cap_below_meta_minimum: true});
  });

  it('V-E10: COP sin centavos, USD en centavos; periodo = mes calendario en America/Bogota', () => {
    expect(toMinor(500_000, 'COP')).toBe(500_000);
    expect(toMinor(150.25, 'USD')).toBe(15_025);
    expect(toMajor(15_025, 'USD')).toBe(150.25);
    expect(budgetPeriod(new Date('2027-08-27T03:00:00Z'))).toEqual({start: '2027-07-27', end: '2027-08-26'});
    expect(budgetPeriod(new Date('2026-12-06T12:00:00Z'))).toEqual({start: '2026-11-27', end: '2026-12-24'});
  });
});

describe('presupuesto mensual del agente: revisiones (AAB-012, C-13)', () => {
  let db: TestDatabase;
  let service: AgentBudgetService;
  const now = new Date('2027-08-16T12:00:00Z');
  const cop = (amount: number) => ({amount: {amount, currency: 'COP'}});

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    await db.database.pool.query('DELETE FROM assistant.agent_monthly_budgets');
    service = new AgentBudgetService(new AgentBudgetRepository(db.database),
      async (_userId, businessId) => {if (businessId === FOREIGN) throw notFound();}, () => now);
  });

  it('sin presupuesto: amount null y revision null; If-Match * crea la 1; "1" crea la 2 y cierra la 1', async () => {
    expect(AgentMonthlyBudgetV1.parse(await service.get(USER_ID, BUSINESS)))
      .toEqual({business_id: BUSINESS, amount: null, period: 'monthly', period_start: '2027-07-27', period_end: '2027-08-26', revision: null, updated_at: null});
    expect(await service.put(USER_ID, BUSINESS, '*', cop(500_000))).toMatchObject({revision: 1, amount: {amount: 500_000, currency: 'COP'}});
    expect(await service.put(USER_ID, BUSINESS, '"1"', cop(800_000))).toMatchObject({revision: 2, amount: {amount: 800_000}});
    const {rows} = await db.database.pool.query(
      'SELECT revision, superseded_at IS NULL AS current, set_by FROM assistant.agent_monthly_budgets WHERE business_id=$1 ORDER BY revision', [BUSINESS]);
    expect(rows).toEqual([{revision: 1, current: false, set_by: 'owner'}, {revision: 2, current: true, set_by: 'owner'}]);
  });

  it('revisión vieja: 412 BUDGET_REVISION_CONFLICT; repetir el mismo PUT devuelve la vigente', async () => {
    await service.put(USER_ID, BUSINESS, '*', cop(500_000));
    await expect(service.put(USER_ID, BUSINESS, '*', cop(900_000))).rejects.toMatchObject({code: 'BUDGET_REVISION_CONFLICT', status: 412});
    await service.put(USER_ID, BUSINESS, '"1"', cop(800_000));
    await expect(service.put(USER_ID, BUSINESS, '"1"', cop(700_000))).rejects.toMatchObject({code: 'BUDGET_REVISION_CONFLICT'});
    expect(await service.put(USER_ID, BUSINESS, '"1"', cop(800_000))).toMatchObject({revision: 2});
  });

  it('negocio ajeno: 404 sin escribir; If-Match inválido: 400', async () => {
    await expect(service.put(USER_ID, FOREIGN, '*', cop(500_000))).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(service.put(USER_ID, BUSINESS, 'W/"x"', cop(500_000))).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    expect((await service.get(USER_ID, BUSINESS)).revision).toBeNull();
  });

  it('la evaluación interna usa la fila vigente del dueño', async () => {
    await service.put(USER_ID, BUSINESS, '*', cop(500_000));
    expect(await service.evaluate(USER_ID, {business_id: BUSINESS, ...base})).toMatchObject({decision: 'within', monthly_minor: 500_000, revision: 1});
    expect(await service.evaluate('otro-usuario', {business_id: BUSINESS, ...base})).toMatchObject({decision: 'no_budget'});
  });
});
