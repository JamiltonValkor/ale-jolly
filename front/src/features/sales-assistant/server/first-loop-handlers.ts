import 'server-only'
import {
  FirstLoopAcceptedV1,
  FirstLoopFeedbackRequestV1,
  FirstLoopKickoffRequestV1,
  FirstLoopMessageRequestV1,
  FirstLoopStateV1,
  FirstLoopWorkV1,
  ResponseLocaleV1,
} from '../types/first-loop.schemas'
import { bffError, bffJson } from './bff-http'
import { idempotencyKey, isUuid } from './orqa-http'
import { readJsonBody } from './request-body'
import { metaAssistantBindings } from './route-bindings'
import { servicesFor } from './service-context'
import { legacyFirstLoopPilotEnabled } from './first-loop-runtime-capabilities'
import { synchronizeConfiguredLanguage } from './configured-language'
import type {
  SalesAssistantHandler,
  SalesAssistantRouteContext,
} from './with-session'

const base = (businessId: string) =>
  `/assistants/me/businesses/${businessId}/first-loop` as const
const MAX_BODY = 40 * 1024

const state: SalesAssistantHandler = async (request, context) => {
  const businessId = context.params.businessId
  const hint = new URL(request.url).searchParams.get('response_locale')
  if (
    !isUuid(businessId) ||
    (hint !== null && !ResponseLocaleV1.safeParse(hint).success)
  )
    return bffError(400, 'INVALID_REQUEST')
  const configured = await synchronizeConfiguredLanguage(context)
  if ('response' in configured) return configured.response
  return servicesFor(context).relay({
    method: 'GET',
    path: `${base(businessId)}?response_locale=${encodeURIComponent(configured.locale)}`,
    schema: FirstLoopStateV1,
    // Managed first use can wait for bounded metadata application and its ACK.
    ...(legacyFirstLoopPilotEnabled() ? {} : { timeoutMs: 90_000 }),
  })
}
/** Legacy has no receipt resource. A non-match is uncertainty, never proof of absence. */
const legacyReceipt: SalesAssistantHandler = async (request, context) => {
  const { businessId, messageId } = context.params
  const expectedFlow = new URL(request.url).searchParams.get('flow_id')
  if (!expectedFlow || !isUuid(expectedFlow))
    return bffError(400, 'INVALID_REQUEST')
  const configured = await synchronizeConfiguredLanguage(context)
  if ('response' in configured) return configured.response
  const result = await servicesFor(context).call({
    method: 'GET',
    path: `${base(businessId)}?response_locale=${encodeURIComponent(configured.locale)}`,
    schema: FirstLoopStateV1,
  })
  if (!result.ok)
    return result.response.status === 404
      ? bffError(409, 'INVALID_REQUEST')
      : result.response
  const parsed = FirstLoopStateV1.safeParse(result.data)
  if (!parsed.success) return bffError(503, 'SERVICE_UNAVAILABLE')
  const value = parsed.data
  if (
    value.business_id !== businessId ||
    value.flow_id !== expectedFlow ||
    value.latest_turn?.client_message_id !== messageId ||
    (value.work &&
      (value.work.business_id !== businessId ||
        value.work.flow_id !== expectedFlow ||
        value.work.work_id !== value.active_work_id))
  )
    return bffError(409, 'INVALID_REQUEST')
  return bffJson(
    FirstLoopAcceptedV1.parse({
      flow_id: value.flow_id,
      session_id: value.session_id,
      work_id: value.active_work_id,
      turn: value.latest_turn,
    })
  )
}

const receipt: SalesAssistantHandler = async (request, context) => {
  const { businessId, messageId } = context.params
  if (!isUuid(businessId) || !isUuid(messageId))
    return bffError(400, 'INVALID_REQUEST')
  if (legacyFirstLoopPilotEnabled()) return legacyReceipt(request, context)
  return servicesFor(context).relay({
    method: 'GET',
    path: `${base(businessId)}/messages/${messageId}`,
    schema: FirstLoopAcceptedV1,
  })
}
const work: SalesAssistantHandler = async (_request, context) => {
  const { businessId, workId } = context.params
  if (!isUuid(businessId) || !isUuid(workId))
    return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'GET',
    path: `${base(businessId)}/works/${workId}`,
    schema: FirstLoopWorkV1,
  })
}

/** Kickoff has no locale field; the legacy GET stores the verified preference in that flow. */
async function prepareLegacyKickoffLocale(
  body: unknown,
  context: SalesAssistantRouteContext,
  locale: string
): Promise<Response | null> {
  const { flow_id } = FirstLoopKickoffRequestV1.parse(body)
  const businessId = context.params.businessId
  const result = await servicesFor(context).call({
    method: 'GET',
    path: `${base(businessId)}?response_locale=${encodeURIComponent(locale)}`,
    schema: FirstLoopStateV1,
  })
  if (!result.ok) return result.response
  return result.data.business_id === businessId &&
    result.data.flow_id === flow_id
    ? null
    : bffError(409, 'INVALID_REQUEST')
}

function mutation(
  kind: 'messages' | 'kickoff' | 'feedback'
): SalesAssistantHandler {
  return async (request, context) => {
    const { businessId, workId } = context.params
    const key = kind === 'messages' ? null : idempotencyKey(request)
    if (
      !isUuid(businessId) ||
      (kind !== 'messages' && !key) ||
      (kind === 'feedback' && !isUuid(workId))
    )
      return bffError(400, 'INVALID_REQUEST')
    const schema =
      kind === 'messages'
        ? FirstLoopMessageRequestV1
        : kind === 'kickoff'
          ? FirstLoopKickoffRequestV1
          : FirstLoopFeedbackRequestV1
    const body = await readJsonBody<unknown>(request, schema, MAX_BODY)
    if (!body) return bffError(400, 'INVALID_REQUEST')
    const configured = await synchronizeConfiguredLanguage(context)
    if ('response' in configured) return configured.response
    if (legacyFirstLoopPilotEnabled() && kind === 'kickoff') {
      const failure = await prepareLegacyKickoffLocale(
        body,
        context,
        configured.locale
      )
      if (failure) return failure
    }
    const suffix = kind === 'feedback' ? `works/${workId}/feedback` : kind
    const result = await servicesFor(context).call({
      method: 'POST',
      path: `${base(businessId)}/${suffix}`,
      headers: key ? { 'Idempotency-Key': key } : undefined,
      body:
        legacyFirstLoopPilotEnabled() &&
        kind !== 'kickoff' &&
        typeof body === 'object' &&
        body !== null
          ? { ...body, response_locale: configured.locale }
          : body,
      schema: FirstLoopAcceptedV1,
    })
    return result.ok ? bffJson(result.data, 202) : result.response
  }
}

export const firstLoopRoutes = {
  state: { GET: metaAssistantBindings.read(state) },
  messages: { POST: metaAssistantBindings.mutate(mutation('messages')) },
  receipt: { GET: metaAssistantBindings.read(receipt) },
  kickoff: { POST: metaAssistantBindings.mutate(mutation('kickoff')) },
  work: { GET: metaAssistantBindings.read(work) },
  feedback: { POST: metaAssistantBindings.mutate(mutation('feedback')) },
}
