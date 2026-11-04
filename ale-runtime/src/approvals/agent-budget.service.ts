import type {AgentBudgetEvaluationRequestV1, AgentBudgetEvaluationV1, AgentMonthlyBudgetV1, AgentMonthlyBudgetUpdateRequestV1} from '../contracts/v1';
import {budgetRevisionConflict, invalidRequest} from '../domain/errors';
import {
  type AgentBudgetRepository, type AgentBudgetRow, budgetMinor, budgetPeriod, BudgetRevisionConflict, budgetView, evaluateAgentBudget, toMinor,
} from './agent-budget';

export const AGENT_BUDGET_SERVICE = Symbol('AGENT_BUDGET_SERVICE');

/**
 * Presupuesto mensual aprobado del agente (AAB-012, D23, C-13). La web lo lee y lo cambia con la sesión del dueño;
 * la Agent API y el espejo solo lo leen y lo evalúan por las rutas internas. Ninguna ruta interna lo escribe.
 */
export class AgentBudgetService {
  constructor(
    private readonly repository: AgentBudgetRepository,
    /** Propiedad del negocio con el patrón `ownedToken` (503 si no se sabe, 404 si es ajeno). */
    private readonly assertOwned: (userId: string, businessId: string) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async ownCurrent(userId: string, businessId: string): Promise<AgentBudgetRow | null> {
    const row = await this.repository.current(businessId);
    return row && row.user_id === userId ? row : null;
  }

  async get(userId: string, businessId: string): Promise<AgentMonthlyBudgetV1> {
    await this.assertOwned(userId, businessId);
    return budgetView(businessId, await this.ownCurrent(userId, businessId), this.now());
  }

  /**
   * `If-Match: "<revision>"` o `*` (sin presupuesto). Repetir el mismo PUT (misma clave tras un timeout) devuelve el
   * vigente si ya quedó con ese monto en la revisión siguiente.
   */
  async put(userId: string, businessId: string, ifMatch: string, input: AgentMonthlyBudgetUpdateRequestV1): Promise<AgentMonthlyBudgetV1> {
    const expected = ifMatch.trim() === '*' ? null : Number(/^"?(\d{1,9})"?$/.exec(ifMatch.trim())?.[1] ?? NaN);
    if (expected !== null && !Number.isInteger(expected)) throw invalidRequest();
    await this.assertOwned(userId, businessId);
    const amountMinor = toMinor(input.amount.amount, input.amount.currency);
    if (amountMinor <= 0 || !Number.isSafeInteger(amountMinor)) throw invalidRequest();
    const now = this.now();
    try {
      const row = await this.repository.set({
        businessId, userId, amountMinor, currency: input.amount.currency, periodStart: budgetPeriod(now).start, expectedRevision: expected, now,
      });
      return budgetView(businessId, row, now);
    } catch (error) {
      if (!(error instanceof BudgetRevisionConflict)) throw error;
      const current = await this.ownCurrent(userId, businessId);
      const replay = current && current.revision === (expected ?? 0) + 1 && budgetMinor(current) === amountMinor && current.currency === input.amount.currency;
      if (replay) return budgetView(businessId, current, now);
      throw budgetRevisionConflict();
    }
  }

  /** Interno: el vigente que fijó este dueño (sin propiedad de negocio: la Agent API ya la verificó). */
  async internalGet(userId: string, businessId: string): Promise<AgentMonthlyBudgetV1> {
    return budgetView(businessId, await this.ownCurrent(userId, businessId), this.now());
  }

  async evaluate(userId: string, input: AgentBudgetEvaluationRequestV1): Promise<AgentBudgetEvaluationV1> {
    const row = await this.ownCurrent(userId, input.business_id);
    return evaluateAgentBudget(row ? {amount_minor: budgetMinor(row), currency: row.currency, revision: row.revision} : null, {
      currency: input.currency, spent_to_date_minor: input.spent_to_date_minor, projected_active_minor: input.projected_active_minor,
      requested_delta_minor: input.requested_delta_minor, campaign_spent_minor: input.campaign_spent_minor,
    });
  }
}
