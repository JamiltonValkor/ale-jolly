import 'server-only'
import { randomUUID } from 'node:crypto'
import { getSession } from '@/lib/auth/auth'
import { isUsableSession, type UsableSession } from '@/lib/auth/session-health'
import {
  isSameOriginRequest,
  resolveBrowserOrigin,
} from '@/shared/lib/bff/browser-origin'

/**
 * Base del BFF `/api/autonomous-team/*` (AAF-001): mismo origen (403), sesión
 * web usable (401) y cualquier fallo inesperado como 503. El token web lo
 * inyecta el gateway; la propiedad del negocio la decide cada servicio.
 * Errores siempre `{code, request_id}` sin detalle técnico.
 */

const CODE = /^[A-Z0-9_]{1,64}$/
export const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
} as const

export function bffError(status: number, code: string): Response {
  return Response.json(
    {
      code: CODE.test(code) ? code : 'SERVICE_UNAVAILABLE',
      request_id: randomUUID(),
    },
    { status, headers: PRIVATE_HEADERS }
  )
}

export function bffJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: PRIVATE_HEADERS })
}

export interface RouteContext {
  session: UsableSession
  params: Record<string, string>
}
export type Handler = (
  request: Request,
  context: RouteContext
) => Promise<Response>
interface NextRouteContext {
  params: Promise<Record<string, string>>
}

async function usableSession(): Promise<UsableSession | null> {
  try {
    const session: unknown = await getSession()
    return isUsableSession(session) ? session : null
  } catch {
    return null
  }
}

function withSession(handler: Handler, mutation: boolean) {
  return async (request: Request, context: NextRouteContext) => {
    const origin = resolveBrowserOrigin()
    if (!origin) return bffError(503, 'SERVICE_UNAVAILABLE')
    if (!isSameOriginRequest(request, origin, mutation))
      return bffError(403, 'FORBIDDEN_ORIGIN')
    const session = await usableSession()
    if (!session) return bffError(401, 'UNAUTHORIZED')
    try {
      return await handler(request, {
        session,
        params: (await context.params) ?? {},
      })
    } catch {
      return bffError(503, 'SERVICE_UNAVAILABLE')
    }
  }
}

export const read = (handler: Handler) => withSession(handler, false)
export const mutate = (handler: Handler) => withSession(handler, true)
