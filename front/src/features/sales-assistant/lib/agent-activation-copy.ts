import type { AgentActivationDetails, Approval } from '../types'

/** Detalle del encendido del agente si la aprobación es de ese tipo (AAF-003). */
export function activationDetails(
  approval: Approval
): AgentActivationDetails | null {
  const details = approval.details
  return approval.kind === 'activate_agent_publication' &&
    details &&
    !details.code_required
    ? details
    : null
}

export type ApproveCopy =
  | { key: 'approve' }
  | {
      key: 'approveRaise' | 'approveSet'
      money: { amount: number; currency: string }
    }

/**
 * D13/D23: si el encendido supera el presupuesto, aprobar sube el presupuesto
 * (o fija el primero) al monto propuesto en la misma decisión.
 */
export function approveCopy(details: AgentActivationDetails): ApproveCopy {
  const proposed = details.budget.proposed_monthly
  if (!details.budget.exceeds || !proposed) return { key: 'approve' }
  return {
    key: details.budget.monthly ? 'approveRaise' : 'approveSet',
    money: proposed,
  }
}

const KNOWN_FAILURES = new Set([
  'BUDGET_EXCEEDED',
  'CURRENCY_MISMATCH',
  'BUDGET_REVISION_CONFLICT',
  'ACTIVATION_OUTCOME_UNKNOWN',
])

/** Resultado tras decidir: clave de `agentActivation.*` y si el presupuesto subió. */
export function activationOutcome(
  approval: Approval,
  details: AgentActivationDetails
): { key: string; budgetRaised: boolean } {
  const result = details.result ?? {}
  const code = typeof result.code === 'string' ? result.code : null
  const budgetRaised = result.budget_raised === true
  if (approval.status === 'failed')
    return {
      key:
        code && KNOWN_FAILURES.has(code) ? `failure.${code}` : 'outcome.failed',
      budgetRaised,
    }
  return { key: `outcome.${approval.status}`, budgetRaised }
}
