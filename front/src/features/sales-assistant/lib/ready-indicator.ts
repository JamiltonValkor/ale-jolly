import type { SalesAssistantMe } from '../types'

/** Polling del estado mientras el asistente se activa (plan de negocio, caso C). */
export const SALES_ASSISTANT_POLL_MS = 30_000

/** Borrar es asíncrono: se consulta seguido para volver pronto a «Activar». */
export const SALES_ASSISTANT_DELETE_POLL_MS = 3_000

/** El dueño tiene algo nuevo: configurar su IA o un asistente listo. */
export function isReadyMilestone(data: SalesAssistantMe): boolean {
  return data.step === 'configure_ai' || data.status === 'ready'
}

function toTime(value: string | null): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

/**
 * Indicador de «listo» en «Mi asistente»: hay hito, el servicio marcó
 * `ready_since` y ese momento es posterior al último que el dueño vio.
 */
export function shouldShowReadyIndicator(
  data: SalesAssistantMe | undefined,
  lastSeen: string | null
): boolean {
  if (!data || !isReadyMilestone(data)) return false
  const readySince = toTime(data.ready_since)
  if (readySince === null) return false
  const seen = toTime(lastSeen)
  return seen === null || readySince > seen
}

/**
 * `refetchInterval` de React Query: 30 s con `status=activating`, 3 s con
 * `status=deleting` y sin polling en los demás estados.
 */
export function salesAssistantPollInterval(
  data: SalesAssistantMe | undefined
): number | false {
  if (data?.status === 'activating') return SALES_ASSISTANT_POLL_MS
  if (data?.status === 'deleting') return SALES_ASSISTANT_DELETE_POLL_MS
  return false
}
