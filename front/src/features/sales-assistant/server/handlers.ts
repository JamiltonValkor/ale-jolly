import 'server-only'
import {
  salesAssistantActivationRequestSchema,
  salesAssistantActivationSchema,
  salesAssistantAiRequestSchema,
  salesAssistantAiResponseSchema,
  salesAssistantMeSchema,
  salesAssistantMessagesSchema,
  salesAssistantProvidersSchema,
  salesAssistantSessionSchema,
  salesAssistantStreamRequestSchema,
  salesAssistantTimezoneRequestSchema,
} from '../types'
import type { AssistantServicePath } from './assistant-service'
import { servicesFor } from './service-context'
import type { AssistantRouteBindings } from './route-bindings'
import { bffError, bffJson } from './bff-http'
import { createAgentBudgetRoutes } from './agent-budget-handlers'
import { createOrqaRoutes } from './orqa-handlers'
import { orqaSharingRoutes } from './orqa-sharing-handlers'
import { createRobotDeviceRoutes } from './robot-devices-handlers'
import { resolveBrowserOrigin } from './browser-origin'
import { readJsonBody } from './request-body'
import {
  withSalesAssistantSession,
  type SalesAssistantHandler,
} from './with-session'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/
/** Mayor que la espera del ack del watcher (60 s) más el turno de prueba (OCB-010). */
const AI_TIMEOUT_MS = 90_000
const AI_MAX_BYTES = 8 * 1024
const TURN_MAX_BYTES = 40 * 1024
const TIMEZONE_MAX_BYTES = 1024

/** Rutas del servicio que responden el estado actual del asistente. */
function stateRoute(
  method: 'GET' | 'POST' | 'DELETE',
  path: AssistantServicePath
): SalesAssistantHandler {
  return (_request, context) =>
    servicesFor(context).relay({ method, path, schema: salesAssistantMeSchema })
}

/**
 * Cuerpo opcional de la activación (OCB-016): sin JSON no hay cuerpo (el
 * servicio usa su zona por defecto); con JSON debe ser `{timezone?}` válido.
 */
async function activationBody(
  request: Request
): Promise<{ ok: true; body?: object } | { ok: false }> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    return { ok: true }
  const body = await readJsonBody(
    request,
    salesAssistantActivationRequestSchema,
    TIMEZONE_MAX_BYTES
  )
  return body ? { ok: true, body } : { ok: false }
}

const activation: SalesAssistantHandler = async (request, context) => {
  const key = request.headers.get('idempotency-key')
  if (!key || !IDEMPOTENCY_KEY.test(key))
    return bffError(400, 'INVALID_REQUEST')
  const input = await activationBody(request)
  if (!input.ok) return bffError(400, 'INVALID_REQUEST')
  const result = await servicesFor(context).call({
    method: 'POST',
    path: '/assistants/me/activation',
    headers: { 'Idempotency-Key': key },
    body: input.body,
    schema: salesAssistantActivationSchema,
  })
  if (!result.ok) return result.response
  const response = bffJson(result.data)
  if ('authorize_url' in result.data) {
    const secure = resolveBrowserOrigin()?.startsWith('https:') ?? true
    response.headers.append(
      'Set-Cookie',
      servicesFor(context).activationCookie(result.data.authorize_url, secure)
    )
  }
  return response
}

/** La key viaja solo en este PUT: no se guarda, no se loguea, no vuelve. */
const configureAi: SalesAssistantHandler = async (request, context) => {
  const body = await readJsonBody(
    request,
    salesAssistantAiRequestSchema,
    AI_MAX_BYTES
  )
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'PUT',
    path: '/assistants/me/ai',
    body,
    timeoutMs: AI_TIMEOUT_MS,
    schema: salesAssistantAiResponseSchema,
  })
}

/** Zona del navegador (OCB-016) → `PUT /assistants/me/timezone`, responde el estado. */
const timezone: SalesAssistantHandler = async (request, context) => {
  const body = await readJsonBody(
    request,
    salesAssistantTimezoneRequestSchema,
    TIMEZONE_MAX_BYTES
  )
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'PUT',
    path: '/assistants/me/timezone',
    body,
    schema: salesAssistantMeSchema,
  })
}

const messages: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!SESSION_ID.test(params.id ?? '')) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `/assistants/me/sessions/${encodeURIComponent(params.id)}/messages`,
    template: '/assistants/me/sessions/:id/messages',
    schema: salesAssistantMessagesSchema,
  })
}

const stream: SalesAssistantHandler = async (request, context) => {
  const { params, session } = context
  if (!SESSION_ID.test(params.id ?? '')) return bffError(400, 'INVALID_REQUEST')
  const body = await readJsonBody(
    request,
    salesAssistantStreamRequestSchema,
    TURN_MAX_BYTES
  )
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).stream({
    path: `/assistants/me/sessions/${encodeURIComponent(params.id)}/stream`,
    template: '/assistants/me/sessions/:id/stream',
    body,
    accessToken: session.accessToken,
    signal: request.signal,
  })
}

const createSession: SalesAssistantHandler = (_request, context) =>
  servicesFor(context).relay({
    method: 'POST',
    path: '/assistants/me/sessions',
    schema: salesAssistantSessionSchema,
  })

const providers: SalesAssistantHandler = (_request, context) =>
  servicesFor(context).relay({
    method: 'GET',
    path: '/assistants/me/providers',
    schema: salesAssistantProvidersSchema,
  })

const read = (handler: SalesAssistantHandler) =>
  withSalesAssistantSession(handler)
const mutate = (handler: SalesAssistantHandler) =>
  withSalesAssistantSession(handler, { mutation: true })

/**
 * Rutas `/api/sales-assistant/*` → `sa-assistant-service` por el gateway
 * (`/api/assistant` + ruta del servicio). Los route.ts de `src/app` solo
 * reexportan estos handlers.
 */
export function createSalesAssistantRoutes(
  bindings: AssistantRouteBindings = { read, mutate }
) {
  const { read, mutate } = bindings
  return {
    me: {
      GET: read(stateRoute('GET', '/assistants/me')),
      DELETE: mutate(stateRoute('DELETE', '/assistants/me')),
    },
    activation: { POST: mutate(activation) },
    providers: { GET: read(providers) },
    ai: { PUT: mutate(configureAi) },
    sessions: { POST: mutate(createSession) },
    messages: { GET: read(messages) },
    stream: { POST: mutate(stream) },
    stop: { POST: mutate(stateRoute('POST', '/assistants/me/stop')) },
    start: { POST: mutate(stateRoute('POST', '/assistants/me/start')) },
    timezone: { PUT: mutate(timezone) },
    // ORQA del usuario (OSF-001…005).
    ...createOrqaRoutes(bindings),
    ...orqaSharingRoutes,
    // API agencial (AAF-001): presupuesto mensual aprobado del agente.
    ...createAgentBudgetRoutes(bindings),
    // Canal robot (CR-004): vincular el compañero físico «Ale».
    ...createRobotDeviceRoutes(bindings),
  }
}

export const salesAssistantRoutes = createSalesAssistantRoutes()
