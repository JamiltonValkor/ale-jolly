import {randomUUID} from 'node:crypto';
import type {AgentBudgetEvaluationRequestV1, AgentBudgetEvaluationV1, AgentMonthlyBudgetV1} from '../contracts/v1';
import type {Database} from '../persistence/database';

/**
 * Presupuesto mensual aprobado del agente (AAB-012, D23). Lo fija el dueño en la web; la Agent API y el espejo
 * lo consultan con una evaluación pura antes de encender o subir presupuestos. Montos internos en el offset de
 * Meta (`*_minor`): COP, JPY y otras sin decimales = unidades enteras; el resto = centavos (V-E10).
 */

/** Monedas que Meta maneja con offset 1 (sin centavos). */
const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
export const metaOffset = (currency: string): number => OFFSET_ONE.has(currency) ? 1 : 100;
export const toMinor = (amount: number, currency: string): number => Math.round(amount * metaOffset(currency));
export const toMajor = (minor: number, currency: string): number => minor / metaOffset(currency);

/**
 * Mínimo de `spend_cap` de campaña en Meta, ≈ US$ 100 en moneda local (V-E6), en `*_minor`. Si el tope
 * calculado queda por debajo no se sube al mínimo (permitiría gastar más de lo aprobado): la activación va sin
 * `spend_cap` y el respaldo es la evaluación interna. Moneda sin dato: tampoco se pone tope.
 */
const META_SPEND_CAP_MINIMUM_MINOR: Readonly<Record<string, number>> = {
  USD: 10_000, EUR: 10_000, COP: 400_000, MXN: 200_000, CLP: 95_000, PEN: 38_000, ARS: 10_000_000, BRL: 55_000,
};

/** Zona del periodo mientras no se confirme la de la cuenta publicitaria (C-13, V-E10). */
export const BUDGET_TIME_ZONE = 'America/Bogota';

export function budgetPeriod(now: Date, timeZone = BUDGET_TIME_ZONE): {start: string; end: string} {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit'}).formatToParts(now);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const pad = (value: number) => String(value).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(last)}`};
}

export interface AgentBudgetRow {
  id: string;
  business_id: string;
  user_id: string;
  amount_minor: string | number;
  currency: string;
  period_start: string | Date;
  revision: number;
  set_at: Date;
}

/**
 * Evaluación pura: `projected = spent + active + delta`; `within` si `projected ≤ monthly`, `exceeds` si no y
 * `no_budget` sin fila vigente. Otra moneda que la del presupuesto = `exceeds` con `CURRENCY_MISMATCH`.
 * `campaign_spend_cap_minor = campaign_spent + max(0, monthly − spent − active)`, o null bajo el mínimo de Meta.
 */
export function evaluateAgentBudget(
  budget: {amount_minor: number; currency: string; revision: number} | null,
  input: Omit<AgentBudgetEvaluationRequestV1, 'business_id'>,
): AgentBudgetEvaluationV1 {
  const projected = input.spent_to_date_minor + input.projected_active_minor + input.requested_delta_minor;
  if (!budget) {
    return {decision: 'no_budget', code: null, remaining_minor: 0, projected_minor: projected, monthly_minor: null, revision: null,
      campaign_spend_cap_minor: null, spend_cap_below_meta_minimum: false};
  }
  if (budget.currency !== input.currency) {
    return {decision: 'exceeds', code: 'CURRENCY_MISMATCH', remaining_minor: 0, projected_minor: projected, monthly_minor: budget.amount_minor,
      revision: budget.revision, campaign_spend_cap_minor: null, spend_cap_below_meta_minimum: false};
  }
  const headroom = Math.max(0, budget.amount_minor - input.spent_to_date_minor - input.projected_active_minor);
  const cap = (input.campaign_spent_minor ?? 0) + headroom;
  const minimum = META_SPEND_CAP_MINIMUM_MINOR[input.currency];
  const below = minimum === undefined || cap < minimum;
  return {
    decision: projected <= budget.amount_minor ? 'within' : 'exceeds',
    code: null,
    remaining_minor: budget.amount_minor - projected,
    projected_minor: projected,
    monthly_minor: budget.amount_minor,
    revision: budget.revision,
    campaign_spend_cap_minor: below ? null : cap,
    spend_cap_below_meta_minimum: below,
  };
}

export class BudgetRevisionConflict extends Error {
  constructor() {
    super('BUDGET_REVISION_CONFLICT');
    this.name = 'BudgetRevisionConflict';
  }
}

/** Historia append-only: cambiar el monto cierra la fila vigente e inserta la revisión siguiente. */
export class AgentBudgetRepository {
  constructor(private readonly db: Database) {}

  async current(businessId: string): Promise<AgentBudgetRow | null> {
    const {rows} = await this.db.pool.query(
      `SELECT id, business_id, user_id, amount_minor, currency, period_start, revision, set_at
         FROM assistant.agent_monthly_budgets WHERE business_id=$1 AND superseded_at IS NULL`, [businessId]);
    return (rows[0] as AgentBudgetRow | undefined) ?? null;
  }

  /**
   * `expectedRevision = null` (If-Match `*`) solo crea la primera; con número, solo reemplaza esa revisión.
   * Una sola sentencia (cerrar la vigente + insertar): dos escrituras con la misma revisión → una gana y la otra
   * no inserta nada (o choca con el índice único parcial) → `BudgetRevisionConflict`.
   */
  async set(input: {businessId: string; userId: string; amountMinor: number; currency: string; periodStart: string; expectedRevision: number | null; now: Date}):
  Promise<AgentBudgetRow> {
    try {
      const {rows} = await this.db.pool.query(
        `WITH closed AS (
           UPDATE assistant.agent_monthly_budgets SET superseded_at=$8
            WHERE business_id=$2 AND superseded_at IS NULL AND $7::int IS NOT NULL AND revision=$7::int
            RETURNING revision)
         INSERT INTO assistant.agent_monthly_budgets (id, business_id, user_id, amount_minor, currency, period_start, revision, set_by, set_at)
         SELECT $1, $2, $3, $4, $5, $6, COALESCE((SELECT revision FROM closed), 0) + 1, 'owner', $8
          WHERE ($7::int IS NULL AND NOT EXISTS (SELECT 1 FROM assistant.agent_monthly_budgets WHERE business_id=$2 AND superseded_at IS NULL))
             OR EXISTS (SELECT 1 FROM closed)
         RETURNING id, business_id, user_id, amount_minor, currency, period_start, revision, set_at`,
        [randomUUID(), input.businessId, input.userId, input.amountMinor, input.currency, input.periodStart, input.expectedRevision, input.now]);
      const row = rows[0] as AgentBudgetRow | undefined;
      if (!row) throw new BudgetRevisionConflict();
      return row;
    } catch (error) {
      if ((error as {code?: string}).code === '23505') throw new BudgetRevisionConflict();
      throw error;
    }
  }
}

export const budgetMinor = (row: AgentBudgetRow): number => Number(row.amount_minor);

export function budgetView(businessId: string, row: AgentBudgetRow | null, now: Date): AgentMonthlyBudgetV1 {
  const period = budgetPeriod(now);
  return {
    business_id: businessId,
    amount: row ? {amount: toMajor(budgetMinor(row), row.currency), currency: row.currency} : null,
    period: 'monthly',
    period_start: period.start,
    period_end: period.end,
    revision: row?.revision ?? null,
    updated_at: row ? row.set_at.toISOString() : null,
  };
}
