import type { SalesAssistantStep } from '../../types'

/** Tras este tiempo en «Conectando tu cuenta» sin avanzar, ofrecemos reintentar. */
export const ACCESS_STUCK_MS = 90_000

export type PreparingAlert = 'none' | 'slow' | 'stuck'

interface Input {
  step: SalesAssistantStep | null
  slow: boolean
  /** Milisegundos en el paso actual (desde que la pantalla lo vio llegar). */
  msAtStep: number
  /** La última activación falló (por ejemplo, la vuelta del acceso no se pudo armar). */
  activationFailed: boolean
}

/**
 * Qué aviso mostrar mientras se prepara el asistente. Solo el paso de acceso
 * se puede reintentar sin riesgo (pide otra vuelta al acceso con una clave
 * nueva); los demás pasos solo avisan que van lentos.
 */
export function preparingAlert({
  step,
  slow,
  msAtStep,
  activationFailed,
}: Input): PreparingAlert {
  const atAccess = step === null || step === 'preparing_access'
  if (atAccess && (activationFailed || msAtStep >= ACCESS_STUCK_MS))
    return 'stuck'
  return slow ? 'slow' : 'none'
}
