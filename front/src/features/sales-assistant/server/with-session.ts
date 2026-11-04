import 'server-only'
import { getSession } from '@/lib/auth/auth'
import { isUsableSession, type UsableSession } from '@/lib/auth/session-health'
import { bffError } from './bff-http'
import { isSameOriginRequest, resolveBrowserOrigin } from './browser-origin'
import type { AssistantRequestServices } from './service-context'

export interface SalesAssistantRouteContext {
  session: UsableSession
  params: Record<string, string>
  /** Explicit request-bound runtime; absent preserves the classic gateway. */
  services?: AssistantRequestServices
}

export type SalesAssistantHandler = (
  request: Request,
  context: SalesAssistantRouteContext
) => Promise<Response>

interface NextRouteContext {
  params: Promise<Record<string, string>>
}

interface Options {
  mutation?: boolean
}

export async function readUsableSession(): Promise<UsableSession | null> {
  try {
    const session: unknown = await getSession()
    return isUsableSession(session) ? session : null
  } catch {
    return null
  }
}

/**
 * Base de toda ruta `/api/sales-assistant/*`: mismo origen (403), sesión web
 * usable (401) y cualquier fallo inesperado como 503 genérico. El token web
 * lo inyecta el cliente de gateway; la bandera la valida el servicio.
 */
export function withSalesAssistantSession(
  handler: SalesAssistantHandler,
  { mutation = false }: Options = {}
): (request: Request, context: NextRouteContext) => Promise<Response> {
  return async (request, context) => {
    const origin = resolveBrowserOrigin()
    if (!origin) return bffError(503, 'SERVICE_UNAVAILABLE')
    if (!isSameOriginRequest(request, origin, mutation))
      return bffError(403, 'FORBIDDEN_ORIGIN')
    const session = await readUsableSession()
    if (!session) return bffError(401, 'UNAUTHORIZED')
    try {
      const params = (await context.params) ?? {}
      return await handler(request, { session, params })
    } catch {
      return bffError(503, 'SERVICE_UNAVAILABLE')
    }
  }
}
