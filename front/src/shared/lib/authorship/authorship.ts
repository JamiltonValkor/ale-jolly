import { z } from 'zod'

/**
 * Autoría de una campaña (AAB-010, C-16, D20): eje *autor*, aparte de la
 * *familia* (`strategy.type`, `plan_origin`). Lo marca campaign-service solo
 * para lo que entra por la Agent API (`/agent/v1`); el front nunca lo envía ni
 * lo infiere del nombre (D28, V-W2). Ausente = legado = hecho en la web.
 *
 * Vive en `shared/` porque lo leen estrategias (campaigns), el panel de
 * aprobación (sales-assistant) y el equipo autónomo (autonomous-team).
 */

export const AGENT_ACTIVATION_STATES = [
  'awaiting_owner_approval',
  'activating',
  'activated',
  'failed',
  'unknown',
] as const
export type AgentActivationState = (typeof AGENT_ACTIVATION_STATES)[number]

export const betRefSchema = z.object({
  bet_id: z.string(),
  strategy_version_id: z.string().nullable(),
  bet_label: z.string().nullable(),
})
export const skillRefSchema = z.object({
  skill_id: z.string(),
  skill_version: z.string().nullable(),
})

/** No estricto: el back puede sumar campos sin romper la lista. */
export const authorshipSchema = z.object({
  origin: z.string(),
  agent_action_id: z.string().nullable().optional(),
  bet_ref: betRefSchema.nullable().optional(),
  skill_ref: skillRefSchema.nullable().optional(),
  approval_id: z.string().nullable().optional(),
  publication_id: z.string().nullable().optional(),
  activation_state: z.string().nullable().optional(),
})
export type Authorship = z.infer<typeof authorshipSchema>
export type BetRef = z.infer<typeof betRefSchema>
export type SkillRef = z.infer<typeof skillRefSchema>

/** Lo mínimo que se lee de un ítem: el bloque nuevo o el `origin` suelto (transitorio). */
export interface AuthoredItem {
  authorship?: unknown
  origin?: unknown
}

export interface ResolvedAuthorship {
  isAgent: boolean
  agentActionId: string | null
  approvalId: string | null
  betLabel: string | null
  skillRef: SkillRef | null
  /** `null` si no es del agente; un valor desconocido se lee `unknown`. */
  activationState: AgentActivationState | null
}

const WEB: ResolvedAuthorship = {
  isAgent: false,
  agentActionId: null,
  approvalId: null,
  betLabel: null,
  skillRef: null,
  activationState: null,
}

function activationStateOf(raw: string | null | undefined) {
  if (!raw) return 'unknown'
  return (AGENT_ACTIVATION_STATES as readonly string[]).includes(raw)
    ? (raw as AgentActivationState)
    : 'unknown'
}

/**
 * `authorship?.origin ?? origin`. Solo `'agent'` marca al equipo autónomo;
 * cualquier otro valor (o ninguno) es la web. El nombre «Ale» es copy i18n.
 */
export function resolveAuthorship(item: AuthoredItem): ResolvedAuthorship {
  const parsed = authorshipSchema.safeParse(item.authorship)
  const block = parsed.success ? parsed.data : null
  const origin = block?.origin ?? item.origin
  if (origin !== 'agent') return WEB
  return {
    isAgent: true,
    agentActionId: block?.agent_action_id ?? null,
    approvalId: block?.approval_id ?? null,
    betLabel: block?.bet_ref?.bet_label ?? null,
    skillRef: block?.skill_ref ?? null,
    activationState: activationStateOf(block?.activation_state),
  }
}

const AGENT_PREFIX = /^\[Ale\]\s*/

/** Quita `[Ale] ` del nombre solo si el ítem es del agente; el del dueño queda intacto. */
export function stripAgentPrefix(name: string, item: AuthoredItem): string {
  if (!resolveAuthorship(item).isAgent) return name
  return name.replace(AGENT_PREFIX, '')
}
