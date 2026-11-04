import 'server-only'
import type { z } from 'zod'
import { ServerApiError, serverGateway } from '@/lib/fetch/server-gateway'
import {
  availableBody,
  isMissingRoute,
  UNAVAILABLE_BODY,
} from '@/shared/lib/bff/upstream-optional'
import { bffError, bffJson, isServiceErrorBody } from './bff-http'

/**
 * Ruta del gateway Envoy de dev hacia sa-assistant-service (OCB-015):
 * `/api/assistant/**` → `sa-assistant-service:8060`, quitando el prefijo.
 * Así `/api/assistant/assistants/me` llega como `/assistants/me` y
 * `/api/assistant/healthz` como `/healthz`. Si OCB-015 acuerda otra
 * reescritura, solo cambia esta constante.
 */
export const ASSISTANT_GATEWAY_PREFIX = '/api/assistant'

export type AssistantServicePath = `/assistants/${string}`

export function assistantGatewayPath(path: AssistantServicePath): string {
  return `${ASSISTANT_GATEWAY_PREFIX}${path}`
}

export interface AssistantServiceCall<T> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: AssistantServicePath
  schema: z.ZodType<T>
  body?: unknown
  /** Plantilla sin ids para Sentry (p. ej. `/assistants/me/sessions/:id`). */
  template?: AssistantServicePath
  timeoutMs?: number
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type AssistantServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response }

function send<T>(call: AssistantServiceCall<T>): Promise<unknown> {
  const endpoint = assistantGatewayPath(call.path)
  const options = {
    timeout: call.timeoutMs ?? 15_000,
    headers: call.headers,
    signal: call.signal,
    sentryTag: 'sales_assistant_bff',
    diagnosticEndpoint: assistantGatewayPath(call.template ?? call.path),
  }
  switch (call.method) {
    case 'GET':
      return serverGateway.get(endpoint, options)
    case 'POST':
      return serverGateway.post(endpoint, call.body, options)
    case 'PUT':
      return serverGateway.put(endpoint, call.body, options)
    case 'DELETE':
      return serverGateway.delete(endpoint, options)
  }
}

/**
 * Error del servicio → navegador. Con contrato `{code, request_id}` se
 * conserva el código (los 5xx salen como 503); sin contrato (Envoy, red,
 * timeout) solo 401 o 503 genéricos. Nunca se reenvía el texto de origen.
 */
export function upstreamFailure(error: unknown): Response {
  if (!(error instanceof ServerApiError)) {
    return bffError(503, 'SERVICE_UNAVAILABLE')
  }
  if (isServiceErrorBody(error.data)) {
    const status = error.status >= 500 ? 503 : error.status
    return bffError(status, error.data.code, error.data.request_id)
  }
  return error.status === 401
    ? bffError(401, 'UNAUTHORIZED')
    : bffError(503, 'SERVICE_UNAVAILABLE')
}

/** Llama al servicio por el gateway con el token web y valida el contrato. */
export async function callAssistantService<T>(
  call: AssistantServiceCall<T>
): Promise<AssistantServiceResult<T>> {
  let data: unknown
  try {
    data = await send(call)
  } catch (error) {
    return { ok: false, response: upstreamFailure(error) }
  }
  const parsed = call.schema.safeParse(data)
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, response: bffError(503, 'SERVICE_UNAVAILABLE') }
}

export async function relayAssistantService<T>(
  call: AssistantServiceCall<T>
): Promise<Response> {
  const result = await callAssistantService(call)
  return result.ok ? bffJson(result.data) : result.response
}

/**
 * Como `relayAssistantService`, para rutas nuevas que el servicio puede no
 * tener aún (AAF-001, V-F2): 404/501 sin contrato → `200 {available:false}`;
 * éxito → `{available:true, data}`. Un error con contrato se conserva.
 */
export async function relayAssistantServiceOptional<T>(
  call: AssistantServiceCall<T>
): Promise<Response> {
  let data: unknown
  try {
    data = await send(call)
  } catch (error) {
    return isMissingRoute(error, isServiceErrorBody)
      ? bffJson(UNAVAILABLE_BODY)
      : upstreamFailure(error)
  }
  const parsed = call.schema.safeParse(data)
  return parsed.success
    ? bffJson(availableBody(parsed.data))
    : bffError(503, 'SERVICE_UNAVAILABLE')
}
