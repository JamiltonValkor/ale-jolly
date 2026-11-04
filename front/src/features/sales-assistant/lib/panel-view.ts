import { SALES_ASSISTANT_STEPS } from '../types/sales-assistant.schemas'
import type { SalesAssistantMe, SalesAssistantStep } from '../types'

/** Lo que muestra el panel «Mi asistente» según `GET /me`. */
export type SalesAssistantView =
  | 'loading'
  | 'activate'
  | 'preparing'
  | 'configureAi'
  | 'failed'
  | 'ready'
  | 'stopped'
  | 'deleting'

/**
 * Traduce el estado del servicio a la vista del panel. `step=configure_ai`
 * manda sobre el estado: el dueño debe configurar su IA (OCF-004).
 */
export function resolveSalesAssistantView(
  data: SalesAssistantMe | undefined
): SalesAssistantView {
  if (!data) return 'loading'
  if (data.status === 'none') return 'activate'
  if (data.status === 'failed') return 'failed'
  if (data.step === 'configure_ai') return 'configureAi'
  if (data.status === 'activating') return 'preparing'
  return data.status
}

export type ActivationStepState = 'done' | 'current' | 'pending'

export interface ActivationStepItem {
  step: SalesAssistantStep
  state: ActivationStepState
}

function stepIndex(step: SalesAssistantStep | null): number {
  return step ? SALES_ASSISTANT_STEPS.indexOf(step) : 0
}

/** Los 4 pasos visibles, marcados respecto al paso actual. */
export function activationStepItems(
  current: SalesAssistantStep | null
): ActivationStepItem[] {
  const index = stepIndex(current)
  return SALES_ASSISTANT_STEPS.map((step, i) => ({
    step,
    state: i < index ? 'done' : i === index ? 'current' : 'pending',
  }))
}

/** Porcentaje honesto: solo cuentan los pasos ya completados. */
export function activationStepPercent(
  current: SalesAssistantStep | null
): number {
  return (stepIndex(current) / SALES_ASSISTANT_STEPS.length) * 100
}
