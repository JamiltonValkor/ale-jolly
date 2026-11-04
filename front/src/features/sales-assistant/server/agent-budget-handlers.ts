import 'server-only'
import { agentBudgetSchema, agentBudgetUpdateSchema } from '../types'
import { servicesFor } from './service-context'
import type { AssistantRouteBindings } from './route-bindings'
import { bffError } from './bff-http'
import { idempotencyKey, isUuid, mutate, read } from './orqa-http'
import { readJsonBody } from './request-body'
import type { SalesAssistantHandler } from './with-session'

/**
 * Presupuesto mensual aprobado del agente (AAB-012, D23, AAF-001): lo fija el
 * dueño con su sesión web; el agente nunca lo escribe (AS exige token web).
 * `?businessId` hace que la verificación de propiedad del gateway aplique al
 * negocio pedido (V-F4); AS vuelve a verificarla.
 */

const IF_MATCH = /^(\*|"[1-9][0-9]{0,9}")$/

const path = (businessId: string) =>
  `/assistants/me/businesses/${businessId}/agent-budget?businessId=${businessId}` as const
const TEMPLATE = '/assistants/me/businesses/:id/agent-budget' as const

const getBudget: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!isUuid(params.businessId)) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).optional({
    method: 'GET',
    path: path(params.businessId),
    template: TEMPLATE,
    schema: agentBudgetSchema,
  })
}

/** Exige `Idempotency-Key`, `If-Match` y cuerpo estricto antes de llamar al servicio. */
const putBudget: SalesAssistantHandler = async (request, context) => {
  const { params } = context
  const key = idempotencyKey(request)
  const ifMatch = request.headers.get('if-match')?.trim() ?? ''
  if (!isUuid(params.businessId) || !key || !IF_MATCH.test(ifMatch))
    return bffError(400, 'INVALID_REQUEST')
  const body = await readJsonBody(request, agentBudgetUpdateSchema, 512)
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).optional({
    method: 'PUT',
    path: path(params.businessId),
    template: TEMPLATE,
    headers: { 'Idempotency-Key': key, 'If-Match': ifMatch },
    body,
    schema: agentBudgetSchema,
  })
}

export function createAgentBudgetRoutes(
  bindings: AssistantRouteBindings = { read, mutate }
) {
  const { read, mutate } = bindings
  return {
    agentBudget: { GET: read(getBudget), PUT: mutate(putBudget) },
  }
}

export const agentBudgetRoutes = createAgentBudgetRoutes()
