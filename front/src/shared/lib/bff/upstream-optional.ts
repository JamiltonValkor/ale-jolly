import 'server-only'
import { ServerApiError } from '@/lib/fetch/server-gateway'

/**
 * Tolerancia mientras el back no está (AAF-001, V-F2): un 404/501 **sin** el
 * contrato de error del servicio es una ruta inexistente (Express o Envoy
 * responden HTML o su propio cuerpo) y la web sigue como hoy. Un 404 con
 * contrato (recurso ajeno o inexistente) no se oculta.
 */
export function isMissingRoute(
  error: unknown,
  hasServiceContract: (data: unknown) => boolean
): boolean {
  return (
    error instanceof ServerApiError &&
    (error.status === 404 || error.status === 501) &&
    !hasServiceContract(error.data)
  )
}

export const UNAVAILABLE_BODY = { available: false } as const

export const availableBody = <T>(data: T) =>
  ({ available: true, data }) as const
