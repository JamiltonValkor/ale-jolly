import 'server-only'
import { UNAVAILABLE_BODY } from '@/shared/lib/bff/upstream-optional'
import {
  STOCK_AREAS,
  stockApproveRequestSchema,
  stockAutonomyAreaSchema,
  stockAutonomyLevelRequestSchema,
  stockAutonomySchema,
  stockItemsSchema,
  stockOrderSchema,
  stockOrdersSchema,
  stockProposalSchema,
  stockProposalsSchema,
  stockRejectRequestSchema,
  stockStatusSchema,
  stockSummarySchema,
} from '../types'
import { bffError, bffJson } from './bff-http'
import { idempotencyKey, isUuid, mutate, read } from './orqa-http'
import { readJsonBody } from './request-body'
import type { AssistantRouteBindings } from './route-bindings'
import { servicesFor } from './service-context'
import type {
  SalesAssistantHandler,
  SalesAssistantRouteContext,
} from './with-session'

/**
 * BFF de Stock (IVF-001). `?businessId` hace que el gateway resuelva el negocio
 * si el usuario es dueño, pero no rechaza a quien no lo es: la barrera es
 * `assertOwned` en el servicio. Solo existe en `metaAssistantRoutes`.
 */

/** 300 emojis son 1200 bytes: un tope menor rechazaría un motivo válido. */
const DECISION_MAX_BYTES = 2048
const IF_MATCH = /^"[1-9][0-9]{0,9}"$/

const stockPath = (businessId: string, suffix: string) =>
  `/assistants/me/businesses/${businessId}/stock/${suffix}?businessId=${businessId}` as const
const template = (suffix: string) =>
  `/assistants/me/businesses/:id/stock/${suffix}` as const

/** Toda ruta sin recurso propio: un 404 aquí solo puede significar apagado. */
const getStatus: SalesAssistantHandler = async (_request, context) => {
  const response = await servicesFor(context).optional({
    method: 'GET',
    path: '/assistants/me/stock/status',
    schema: stockStatusSchema,
  })
  return response.status === 404 ? bffJson(UNAVAILABLE_BODY) : response
}

interface ReadRoute {
  suffix: string
  schema: Parameters<ReturnType<typeof servicesFor>['relay']>[0]['schema']
}

function readRoute({ suffix, schema }: ReadRoute): SalesAssistantHandler {
  return async (_request, context) => {
    const { businessId } = context.params
    if (!isUuid(businessId)) return bffError(400, 'INVALID_REQUEST')
    return servicesFor(context).relay({
      method: 'GET',
      path: stockPath(businessId, suffix),
      template: template(suffix),
      schema,
    })
  }
}

/** Solo `pendiente`: el BFF no reenvía otro parámetro del navegador. */
const getProposals: SalesAssistantHandler = async (request, context) => {
  const { businessId } = context.params
  const status = new URL(request.url).searchParams.get('status')
  if (!isUuid(businessId) || (status !== null && status !== 'pendiente'))
    return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `${stockPath(businessId, 'proposals')}&status=pendiente`,
    template: template('proposals'),
    schema: stockProposalsSchema,
  })
}

function writeHeaders(request: Request) {
  const key = idempotencyKey(request)
  const ifMatch = request.headers.get('if-match')?.trim() ?? ''
  if (!key || !IF_MATCH.test(ifMatch)) return null
  return { 'Idempotency-Key': key, 'If-Match': ifMatch }
}

function decide(
  action: 'approve' | 'reject',
  bodySchema: typeof stockApproveRequestSchema | typeof stockRejectRequestSchema
): SalesAssistantHandler {
  return async (request, context) => {
    const { businessId, proposalId } = context.params
    const headers = writeHeaders(request)
    if (!isUuid(businessId) || !isUuid(proposalId) || !headers)
      return bffError(400, 'INVALID_REQUEST')
    const body = await readJsonBody(request, bodySchema, DECISION_MAX_BYTES)
    if (!body) return bffError(400, 'INVALID_REQUEST')
    return servicesFor(context).relay({
      method: 'POST',
      path: stockPath(businessId, `proposals/${proposalId}/${action}`),
      template: template(`proposals/:pid/${action}`),
      headers,
      body,
      schema: stockProposalSchema,
    })
  }
}

const isArea = (value: string | undefined) =>
  (STOCK_AREAS as readonly (string | undefined)[]).includes(value)

async function lowerLevel(
  request: Request,
  context: SalesAssistantRouteContext
): Promise<Response> {
  const { businessId, area } = context.params
  const headers = writeHeaders(request)
  if (!isUuid(businessId) || !isArea(area) || !headers)
    return bffError(400, 'INVALID_REQUEST')
  const body = await readJsonBody(
    request,
    stockAutonomyLevelRequestSchema,
    DECISION_MAX_BYTES
  )
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'POST',
    path: stockPath(businessId, `autonomy/${area}/level`),
    template: template('autonomy/:area/level'),
    headers,
    body,
    schema: stockAutonomyAreaSchema,
  })
}

/** Sin cuerpo, revisión ni clave: el servicio ya es idempotente en esta ruta. */
const cancelOrder: SalesAssistantHandler = async (_request, context) => {
  const { businessId, orderId } = context.params
  if (!isUuid(businessId) || !isUuid(orderId))
    return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'POST',
    path: stockPath(businessId, `orders/${orderId}/cancel`),
    template: template('orders/:oid/cancel'),
    schema: stockOrderSchema,
  })
}

export function createStockRoutes(
  bindings: AssistantRouteBindings = { read, mutate }
) {
  const { read, mutate } = bindings
  const get = (route: ReadRoute) => ({ GET: read(readRoute(route)) })
  return {
    stockStatus: { GET: read(getStatus) },
    stockSummary: get({ suffix: 'summary', schema: stockSummarySchema }),
    stockItems: get({ suffix: 'items', schema: stockItemsSchema }),
    stockProposals: { GET: read(getProposals) },
    stockApprove: {
      POST: mutate(decide('approve', stockApproveRequestSchema)),
    },
    stockReject: { POST: mutate(decide('reject', stockRejectRequestSchema)) },
    stockOrders: get({ suffix: 'orders', schema: stockOrdersSchema }),
    stockOrderCancel: { POST: mutate(cancelOrder) },
    stockAutonomy: get({ suffix: 'autonomy', schema: stockAutonomySchema }),
    stockAutonomyLevel: { POST: mutate(lowerLevel) },
  }
}
