import 'server-only'
import { z } from 'zod'
import { ServerApiError, serverGateway } from '@/lib/fetch/server-gateway'
import {
  availableBody,
  isMissingRoute,
  UNAVAILABLE_BODY,
} from '@/shared/lib/bff/upstream-optional'
import { bffError, bffJson } from './http'

/**
 * Relay a campaign-service y subscription-service (patrón
 * `features/agent-chat/server/live-budget-http.ts`): sobre `{success, data}`,
 * error `{success:false, error:'CODE'}` → `bffError(status, CODE)`; 5xx → 503.
 * Una ruta inexistente (404/501 sin ese contrato) → `200 {available:false}`.
 * Nunca se reenvía texto de origen.
 */

const serviceErrorSchema = z.object({
  success: z.literal(false),
  error: z.string().regex(/^[A-Z0-9_]{1,64}$/),
})
const hasServiceContract = (data: unknown) =>
  serviceErrorSchema.safeParse(data).success

export function upstreamError(error: unknown): Response {
  if (isMissingRoute(error, hasServiceContract))
    return bffJson(UNAVAILABLE_BODY)
  if (!(error instanceof ServerApiError))
    return bffError(503, 'SERVICE_UNAVAILABLE')
  const parsed = serviceErrorSchema.safeParse(error.data)
  if (error.status >= 500) return bffError(503, 'SERVICE_UNAVAILABLE')
  if (parsed.success) return bffError(error.status, parsed.data.error)
  // authMiddleware de SUB responde `{error:'…'}` sin código estable (V-F3).
  if (error.status === 401) return bffError(401, 'UNAUTHORIZED')
  if (error.status === 403) return bffError(403, 'FORBIDDEN')
  return bffError(503, 'SERVICE_UNAVAILABLE')
}

export interface UpstreamCall<T> {
  method: 'GET' | 'PUT'
  endpoint: string
  /** Plantilla sin ids para Sentry. */
  template: string
  schema: z.ZodType<T>
  body?: unknown
  businessId?: string
  signal?: AbortSignal
}

export async function relayUpstream<T>(
  call: UpstreamCall<T>
): Promise<Response> {
  const options = {
    timeout: 15_000,
    businessId: call.businessId,
    signal: call.signal,
    sentryTag: 'autonomous_team_bff',
    diagnosticEndpoint: call.template,
  }
  let raw: unknown
  try {
    raw =
      call.method === 'GET'
        ? await serverGateway.get<unknown>(call.endpoint, options)
        : await serverGateway.put<unknown>(call.endpoint, call.body, options)
  } catch (error) {
    return upstreamError(error)
  }
  const parsed = z
    .object({ success: z.literal(true), data: call.schema })
    .safeParse(raw)
  return parsed.success
    ? bffJson(availableBody(parsed.data.data))
    : bffError(503, 'SERVICE_UNAVAILABLE')
}
