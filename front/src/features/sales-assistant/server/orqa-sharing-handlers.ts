import 'server-only'
import {
  adminCatalogSchema,
  adminLessonsSchema,
  publishRequestSchema,
  publishResponseSchema,
} from '../types'
import { relayAssistantService } from './assistant-service'
import { bffError } from './bff-http'
import {
  idempotencyKey,
  isUuid,
  ITEM_ID,
  mutate,
  read,
  relayNoContent,
} from './orqa-http'
import { readJsonBody } from './request-body'
import type { SalesAssistantHandler } from './with-session'

/**
 * Buzón admin del Cerebro SaleADS (OSF-005). Compartir lecciones ya no se
 * apaga desde la web (D46/D47, MLF-005): el consentimiento va en los términos. La lista blanca de admins vive solo en el servidor: ante 403 el
 * front pinta «no disponible».
 */

const INDUSTRY = /^[a-z][a-z0-9_]{1,63}$/
const LESSON_STATUS = /^(received|validated|rejected|published)$/
const PUBLISH_BODY = 4 * 1024
const ADMIN = '/assistants/admin/brain-hub' as const

/** Filtros opcionales `industry` y `status`, validados antes de reenviarlos. */
const adminLessons: SalesAssistantHandler = async request => {
  const search = new URL(request.url).searchParams
  const query = new URLSearchParams()
  const industry = search.get('industry')
  const status = search.get('status')
  if (industry !== null && !INDUSTRY.test(industry))
    return bffError(400, 'INVALID_REQUEST')
  if (status !== null && !LESSON_STATUS.test(status))
    return bffError(400, 'INVALID_REQUEST')
  if (industry) query.set('industry', industry)
  if (status) query.set('status', status)
  const suffix = query.size ? `?${query.toString()}` : ''
  return relayAssistantService({
    method: 'GET',
    path: `${ADMIN}/lessons${suffix}`,
    template: `${ADMIN}/lessons`,
    schema: adminLessonsSchema,
  })
}

function review(action: 'validate' | 'reject'): SalesAssistantHandler {
  return async (_request, { params }) => {
    if (!isUuid(params.id)) return bffError(400, 'INVALID_REQUEST')
    return relayNoContent({
      method: 'POST',
      path: `${ADMIN}/lessons/${params.id}/${action}`,
      template: `${ADMIN}/lessons/:id/${action}`,
    })
  }
}

/** Publicar exige `Idempotency-Key`: un doble clic no crea dos versiones. */
const publish: SalesAssistantHandler = async (request, { params }) => {
  const key = idempotencyKey(request)
  if (!isUuid(params.id) || !key) return bffError(400, 'INVALID_REQUEST')
  const body = await readJsonBody(request, publishRequestSchema, PUBLISH_BODY)
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return relayAssistantService({
    method: 'POST',
    path: `${ADMIN}/lessons/${params.id}/publish`,
    template: `${ADMIN}/lessons/:id/publish`,
    headers: { 'Idempotency-Key': key },
    body,
    schema: publishResponseSchema,
  })
}

const adminCatalog: SalesAssistantHandler = () =>
  relayAssistantService({
    method: 'GET',
    path: `${ADMIN}/catalog`,
    schema: adminCatalogSchema,
  })

const retire: SalesAssistantHandler = async (_request, { params }) => {
  if (!ITEM_ID.test(params.itemId ?? ''))
    return bffError(400, 'INVALID_REQUEST')
  return relayNoContent({
    method: 'POST',
    path: `${ADMIN}/catalog/${encodeURIComponent(params.itemId)}/retire`,
    template: `${ADMIN}/catalog/:item/retire`,
  })
}

export const orqaSharingRoutes = {
  adminLessons: { GET: read(adminLessons) },
  adminValidate: { POST: mutate(review('validate')) },
  adminReject: { POST: mutate(review('reject')) },
  adminPublish: { POST: mutate(publish) },
  adminCatalog: { GET: read(adminCatalog) },
  adminRetire: { POST: mutate(retire) },
}
