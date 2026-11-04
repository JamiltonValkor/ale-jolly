import { z } from 'zod'

/**
 * Presupuesto mensual aprobado del agente (AAB-012, D23, C-13), contrato de
 * `sa-assistant-service` (`AgentMonthlyBudgetV1`, MR !62 `cb960f5e`). Vive en
 * `shared/` porque el BFF es de sales-assistant (JSON vendorizado y paridad
 * en `features/sales-assistant/contracts/v1/agent-budget*.schema.json`) y la
 * pestaña «Límites» es del equipo autónomo. Montos en unidades mayores.
 */

const moneySchema = z
  .object({
    amount: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()

export const agentBudgetSchema = z
  .object({
    business_id: z.uuid(),
    amount: moneySchema.nullable(),
    period: z.literal('monthly'),
    period_start: z.iso.date(),
    period_end: z.iso.date(),
    revision: z.number().int().min(1).nullable(),
    updated_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()

/** Cuerpo de `PUT …/agent-budget` (con `Idempotency-Key` e `If-Match: "<revision>"` o `*`). */
export const agentBudgetUpdateSchema = z
  .object({ amount: moneySchema })
  .strict()

export type AgentBudget = z.infer<typeof agentBudgetSchema>
export type AgentBudgetUpdate = z.infer<typeof agentBudgetUpdateSchema>

/** `If-Match` de un guardado: la revisión leída, o `*` si aún no hay presupuesto. */
export function budgetIfMatch(revision: number | null): string {
  return revision === null ? '*' : `"${revision}"`
}
