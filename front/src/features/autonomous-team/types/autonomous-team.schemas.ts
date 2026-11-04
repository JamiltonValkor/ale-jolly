import { z } from 'zod'
import {
  authorshipSchema,
  betRefSchema,
  skillRefSchema,
} from '@/shared/lib/authorship'

/**
 * Contratos v1 del equipo autónomo (ola `saleads-api-agencial-v1`, AAF-001).
 *
 * - Traza del agente: campaign-service `GET /campaigns/agentic/v1/...`
 *   (AAB-010, MR !494 `9f747811`, `src/contracts/agent-trace.ts`). `kind`,
 *   `subject_type`, `state` y `step_kind` llegan como texto y se traducen en
 *   `lib/` (un valor nuevo del back nunca rompe la pantalla).
 * - Tope mensual de créditos: subscription-service
 *   `GET|PUT /api/subscription/credits/agent-cap` (AAB-017, `ed31bbd4`).
 *
 * Esquemas tolerantes (sin `.strict()`), salvo los cuerpos que envía la web.
 * JSON Schema vendorizados en `../contracts/v1/`; el test de paridad los cubre.
 */

const nullableText = z.string().nullable()
const requestArgsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .nullable()

export const agentActionSchema = z.object({
  agent_action_id: z.string(),
  business_id: z.string(),
  trace_id: z.string(),
  kind: z.string(),
  subject_type: z.string(),
  subject_id: nullableText,
  campaign_id: nullableText,
  bet_ref: betRefSchema.nullable(),
  skill_ref: skillRefSchema.nullable(),
  request_summary: nullableText,
  request_args: requestArgsSchema,
  approval_required: z.boolean(),
  approval_id: nullableText,
  state: z.string(),
  outcome_summary: nullableText,
  created_at: z.string(),
  executed_at: nullableText,
})

export const agentActionStepSchema = z.object({
  seq: z.number().int(),
  step_kind: z.string(),
  platform_object_type: nullableText,
  platform_object_id: nullableText,
  before_value: z.unknown(),
  after_value: z.unknown(),
  error: z.unknown(),
  writer: z.string(),
  at: z.string(),
})

/** Gasto calculado al leer (nunca guardado), en unidades mayores. */
export const agentActionSpendSchema = z.object({
  amount: z.number(),
  currency: nullableText,
  since: z.string(),
})

export const agentActionDetailSchema = agentActionSchema.extend({
  steps: z.array(agentActionStepSchema),
  spend: agentActionSpendSchema.nullable(),
  spend_source: z.string(),
})

export const agentActionsPageSchema = z.object({
  items: z.array(agentActionSchema),
  next_cursor: nullableText,
})

/** `cap: null` = sin fijar: el equipo no puede usar créditos (C-14). */
export const agentCreditCapSchema = z.object({
  cap: z.number().int().min(0).nullable(),
  used_this_period: z.number().int(),
  remaining: z.number().int().nullable(),
  period_start: z.string(),
  period_end: z.string(),
})

/** Cuerpo de `PUT agent-cap`: entero ≥ 0, sin `null`. */
export const agentCreditCapUpdateSchema = z
  .object({ cap: z.number().int().min(0) })
  .strict()

/** Nombre del JSON vendorizado → schema. */
export const AUTONOMOUS_TEAM_CONTRACTS_V1 = {
  authorship: authorshipSchema,
  'agent-action': agentActionSchema,
  'agent-action-detail': agentActionDetailSchema,
  'agent-actions-page': agentActionsPageSchema,
  'agent-credit-cap': agentCreditCapSchema,
  'agent-credit-cap-update-request': agentCreditCapUpdateSchema,
} as const

export type AgentAction = z.infer<typeof agentActionSchema>
export type AgentActionStep = z.infer<typeof agentActionStepSchema>
export type AgentActionDetail = z.infer<typeof agentActionDetailSchema>
export type AgentActionsPage = z.infer<typeof agentActionsPageSchema>
export type AgentCreditCap = z.infer<typeof agentCreditCapSchema>
export type AgentCreditCapUpdate = z.infer<typeof agentCreditCapUpdateSchema>

/** Respuesta de las rutas BFF nuevas: el back aún puede no tener la ruta. */
export type Optional<T> = { available: false } | { available: true; data: T }

export const optionalSchema = <T>(schema: z.ZodType<T>) =>
  z.union([
    z.object({ available: z.literal(false) }),
    z.object({ available: z.literal(true), data: schema }),
  ])
