import 'server-only'
import { z } from 'zod'
import {
  approvalCodeResponseSchema,
  approvalDecisionRequestSchema,
  approvalSchema,
  brainFeedbackRequestSchema,
  brainFeedbackResponseSchema,
  brainSnapshotAnySchema,
  brainSnapshotDiffSchema,
  brainSnapshotSchema,
  brainSnapshotsSchema,
  businessProfileSchema,
  businessProfileUpdateSchema,
  catalogViewSchema,
} from '../types'
import { servicesFor } from './service-context'
import type { AssistantRouteBindings } from './route-bindings'
import { bffError } from './bff-http'
import { idempotencyKey, isUuid, ITEM_ID, mutate, read } from './orqa-http'
import { readJsonBody } from './request-body'
import type { SalesAssistantHandler } from './with-session'

/**
 * BFF de ORQA del usuario (ola `saleads-orqa-cliente-mvp-v1`): fotos del
 * cerebro (OSF-001), aprobaciones (OSF-003), catálogo y compartir lecciones
 * (OSF-004) y buzón admin (OSF-005). Ids validados antes de llamar al
 * servicio; la propiedad del negocio y la lista blanca las decide el servicio.
 */

const VERSION = /^[1-9][0-9]{0,6}$/

/** Línea de tiempo de fotos de un negocio (`?limit=1..100`). */
const snapshots: SalesAssistantHandler = async (request, context) => {
  const { params } = context
  if (!isUuid(params.businessId)) return bffError(400, 'INVALID_REQUEST')
  const raw = new URL(request.url).searchParams.get('limit')
  const limit = raw && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : 20
  if (limit < 1 || limit > 100) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `/assistants/me/businesses/${params.businessId}/brain/snapshots?limit=${limit}`,
    template: '/assistants/me/businesses/:id/brain/snapshots',
    schema: brainSnapshotsSchema,
  })
}

/** `?schema=2` (MLF-002): se reenvía y se valida con la unión v1|v2 (un servicio viejo responde v1). */
const snapshot: SalesAssistantHandler = async (request, context) => {
  const { params } = context
  if (!isUuid(params.businessId) || !VERSION.test(params.version ?? ''))
    return bffError(400, 'INVALID_REQUEST')
  const v2 = new URL(request.url).searchParams.get('schema') === '2'
  const path =
    `/assistants/me/businesses/${params.businessId}/brain/snapshots/${params.version}` as const
  if (v2)
    return servicesFor(context).relay({
      method: 'GET',
      path: `/assistants/me/businesses/${params.businessId}/brain/snapshots/${params.version}?schema=2`,
      template:
        '/assistants/me/businesses/:id/brain/snapshots/:version?schema=2',
      schema: brainSnapshotAnySchema,
    })
  return servicesFor(context).relay({
    method: 'GET',
    path,
    template: '/assistants/me/businesses/:id/brain/snapshots/:version',
    schema: brainSnapshotSchema,
  })
}

/** «Qué cambió» entre dos fotos (MLF-003). */
const snapshotDiff: SalesAssistantHandler = async (request, context) => {
  const { params } = context
  const from = new URL(request.url).searchParams.get('from') ?? ''
  if (
    !isUuid(params.businessId) ||
    !VERSION.test(params.version ?? '') ||
    !VERSION.test(from)
  )
    return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `/assistants/me/businesses/${params.businessId}/brain/snapshots/${params.version}/diff?from=${from}`,
    template: '/assistants/me/businesses/:id/brain/snapshots/:version/diff',
    schema: brainSnapshotDiffSchema,
  })
}

const FEEDBACK_BODY = 4 * 1024

/** Confirmar, corregir o «ya no aplica» una memoria (MLF-002): le llega a Ale por un canal aparte. */
const brainFeedback: SalesAssistantHandler = async (request, context) => {
  const { params } = context
  const key = idempotencyKey(request)
  if (!isUuid(params.businessId) || !key)
    return bffError(400, 'INVALID_REQUEST')
  const body = await readJsonBody(
    request,
    brainFeedbackRequestSchema,
    FEEDBACK_BODY
  )
  if (!body || (body.action === 'correct' && !body.text))
    return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'POST',
    path: `/assistants/me/businesses/${params.businessId}/brain/feedback`,
    template: '/assistants/me/businesses/:id/brain/feedback',
    headers: { 'Idempotency-Key': key },
    body,
    schema: brainFeedbackResponseSchema,
  })
}

/** Tipo de negocio (MLF-001): GET precarga desde SaleADS; PUT confirma la elección del dueño. */
const businessProfile: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!isUuid(params.businessId)) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `/assistants/me/businesses/${params.businessId}/profile`,
    template: '/assistants/me/businesses/:id/profile',
    schema: businessProfileSchema,
  })
}

const updateBusinessProfile: SalesAssistantHandler = async (
  request,
  context
) => {
  const { params } = context
  if (!isUuid(params.businessId)) return bffError(400, 'INVALID_REQUEST')
  const body = await readJsonBody(request, businessProfileUpdateSchema, 512)
  if (!body) return bffError(400, 'INVALID_REQUEST')
  const key = idempotencyKey(request)
  return servicesFor(context).relay({
    method: 'PUT',
    path: `/assistants/me/businesses/${params.businessId}/profile`,
    template: '/assistants/me/businesses/:id/profile',
    ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
    body,
    schema: businessProfileSchema,
  })
}

/** Código de un solo uso (simulado) para aprobar una acción de gasto (MLF-006). */
const approvalCode: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!isUuid(params.id)) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'POST',
    path: `/assistants/approvals/${params.id}/code`,
    template: '/assistants/approvals/:id/code',
    schema: approvalCodeResponseSchema,
  })
}

const approval: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!isUuid(params.id)) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `/assistants/approvals/${params.id}`,
    template: '/assistants/approvals/:id',
    schema: approvalSchema,
  })
}

/**
 * Aprobar o rechazar: una `Idempotency-Key` por decisión, reusada en los reintentos.
 * Aprobar una acción de gasto lleva `{code}` (MLF-006); sin cuerpo, como siempre.
 */
function decide(action: 'approve' | 'reject'): SalesAssistantHandler {
  return async (request, context) => {
    const { params } = context
    const key = idempotencyKey(request)
    if (!isUuid(params.id) || !key) return bffError(400, 'INVALID_REQUEST')
    let body: { code?: string } | undefined
    if (
      action === 'approve' &&
      request.headers.get('content-type')?.includes('application/json')
    ) {
      const parsed = await readJsonBody(
        request,
        approvalDecisionRequestSchema,
        256
      )
      if (!parsed) return bffError(400, 'INVALID_REQUEST')
      body = parsed
    }
    return servicesFor(context).relay({
      method: 'POST',
      path: `/assistants/approvals/${params.id}/${action}`,
      template: `/assistants/approvals/:id/${action}`,
      headers: { 'Idempotency-Key': key },
      ...(body ? { body } : {}),
      schema: approvalSchema,
    })
  }
}

const catalog: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!isUuid(params.businessId)) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `/assistants/me/businesses/${params.businessId}/skills/catalog`,
    template: '/assistants/me/businesses/:id/skills/catalog',
    schema: catalogViewSchema,
  })
}

const installResponseSchema = z
  .object({ approval_id: z.uuid(), status: z.string() })
  .strict()

/** Instalar o desinstalar no instala: crea una aprobación (OSB-016). */
function propose(action: 'install' | 'uninstall'): SalesAssistantHandler {
  return async (request, context) => {
    const { params } = context
    if (!isUuid(params.businessId) || !ITEM_ID.test(params.itemId ?? ''))
      return bffError(400, 'INVALID_REQUEST')
    if (!idempotencyKey(request)) return bffError(400, 'INVALID_REQUEST')
    return servicesFor(context).relay({
      method: 'POST',
      path: `/assistants/me/businesses/${params.businessId}/skills/${encodeURIComponent(params.itemId)}/${action}`,
      template: `/assistants/me/businesses/:id/skills/:item/${action}`,
      schema: installResponseSchema,
    })
  }
}

export function createOrqaRoutes(
  bindings: AssistantRouteBindings = { read, mutate }
) {
  const { read, mutate } = bindings
  return {
    snapshots: { GET: read(snapshots) },
    snapshot: { GET: read(snapshot) },
    snapshotDiff: { GET: read(snapshotDiff) },
    brainFeedback: { POST: mutate(brainFeedback) },
    businessProfile: {
      GET: read(businessProfile),
      PUT: mutate(updateBusinessProfile),
    },
    approval: { GET: read(approval) },
    approvalCode: { POST: mutate(approvalCode) },
    approve: { POST: mutate(decide('approve')) },
    reject: { POST: mutate(decide('reject')) },
    catalog: { GET: read(catalog) },
    install: { POST: mutate(propose('install')) },
    uninstall: { POST: mutate(propose('uninstall')) },
  }
}

export const orqaRoutes = createOrqaRoutes()
