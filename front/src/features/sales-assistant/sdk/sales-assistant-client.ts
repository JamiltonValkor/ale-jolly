import type { z } from 'zod'
import {
  SALES_ASSISTANT_ERROR_CODES,
  salesAssistantActivationSchema,
  salesAssistantAiResponseSchema,
  salesAssistantMeSchema,
  salesAssistantMessagesSchema,
  salesAssistantProvidersSchema,
  salesAssistantSessionSchema,
  type SalesAssistantActivation,
  type SalesAssistantAiResponse,
  type SalesAssistantMe,
  type SalesAssistantMessages,
  type SalesAssistantProvider,
  type SalesAssistantServiceErrorCode,
  type SalesAssistantSession,
} from '../types'
import type { OneShotSecret } from '../lib/one-shot-secret'

/** Rutas BFF same-origin (`src/app/api/sales-assistant/*`). */
export const SALES_ASSISTANT_BFF = '/api/sales-assistant'
export const SALES_ASSISTANT_ME_PATH = `${SALES_ASSISTANT_BFF}/me`

/**
 * Códigos estables que ve la UI: los del servicio, `FORBIDDEN_ORIGIN` del BFF,
 * `UNAVAILABLE` (sin red o error sin contrato) e `INVALID_RESPONSE`. La UI
 * traduce el código; nunca muestra el detalle técnico.
 */
export type SalesAssistantClientErrorCode =
  | SalesAssistantServiceErrorCode
  | 'FORBIDDEN_ORIGIN'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'

const KNOWN_CODES = new Set<string>([
  ...SALES_ASSISTANT_ERROR_CODES,
  'FORBIDDEN_ORIGIN',
])

export class SalesAssistantClientError extends Error {
  constructor(
    readonly code: SalesAssistantClientErrorCode,
    readonly status: number | null = null
  ) {
    super(code)
    this.name = 'SalesAssistantClientError'
  }
}

export interface RequestInitLite {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function failure(response: Response): Promise<SalesAssistantClientError> {
  const body: unknown = await response.json().catch(() => null)
  const code =
    body && typeof body === 'object' && 'code' in body ? body.code : null
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? new SalesAssistantClientError(
        code as SalesAssistantClientErrorCode,
        response.status
      )
    : new SalesAssistantClientError('UNAVAILABLE', response.status)
}

/** fetch same-origin al BFF; el token web lo pone el servidor, nunca el navegador. */
export async function salesAssistantFetch(
  path: string,
  init: RequestInitLite = {},
  bffPrefix = SALES_ASSISTANT_BFF
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${bffPrefix}${path}`, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: init.headers,
      signal: init.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new SalesAssistantClientError('UNAVAILABLE')
  }
  if (!response.ok) throw await failure(response)
  return response
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInitLite,
  bffPrefix = SALES_ASSISTANT_BFF
): Promise<T> {
  const response = await salesAssistantFetch(path, init, bffPrefix)
  const raw: unknown = await response.json().catch(() => null)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new SalesAssistantClientError('INVALID_RESPONSE')
  return parsed.data
}

export function fetchSalesAssistantMe(
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<SalesAssistantMe> {
  return request('/me', salesAssistantMeSchema, { signal })
}

/**
 * Idempotente: el mismo key por usuario hasta que `status` deje de ser `none`.
 * Con `timezone` (zona IANA del navegador, OCB-016) manda `{timezone}`; un
 * back viejo ignora el cuerpo.
 */
export function requestSalesAssistantActivation(
  idempotencyKey: string,
  timezone?: string,
  request: typeof requestJson = requestJson
): Promise<SalesAssistantActivation> {
  const headers: Record<string, string> = { 'Idempotency-Key': idempotencyKey }
  if (!timezone)
    return request('/activation', salesAssistantActivationSchema, {
      method: 'POST',
      headers,
    })
  return request('/activation', salesAssistantActivationSchema, {
    method: 'POST',
    body: JSON.stringify({ timezone }),
    headers: { ...headers, ...JSON_HEADERS },
  })
}

/** `PUT /timezone` (OCB-016): lleva la zona del navegador al asistente. */
export function updateSalesAssistantTimezone(
  timezone: string,
  request: typeof requestJson = requestJson
): Promise<SalesAssistantMe> {
  return request('/timezone', salesAssistantMeSchema, {
    method: 'PUT',
    body: JSON.stringify({ timezone }),
    headers: JSON_HEADERS,
  })
}

export function fetchSalesAssistantProviders(
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<SalesAssistantProvider[]> {
  return request('/providers', salesAssistantProvidersSchema, { signal })
}

export interface SalesAssistantAiInput {
  provider: string
  model: string
  /** La key se consume al armar el cuerpo; nunca queda en estado ni cache. */
  apiKey: OneShotSecret
}

export function configureSalesAssistantAi(
  input: SalesAssistantAiInput,
  request: typeof requestJson = requestJson
): Promise<SalesAssistantAiResponse> {
  const body = JSON.stringify({
    provider: input.provider,
    model: input.model,
    api_key: input.apiKey.take(),
  })
  return request('/ai', salesAssistantAiResponseSchema, {
    method: 'PUT',
    body,
    headers: JSON_HEADERS,
  })
}

export function createSalesAssistantSession(
  request: typeof requestJson = requestJson
): Promise<SalesAssistantSession> {
  return request('/sessions', salesAssistantSessionSchema, {
    method: 'POST',
  })
}

export function fetchSalesAssistantMessages(
  sessionId: string,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<SalesAssistantMessages> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/messages`
  return request(path, salesAssistantMessagesSchema, { signal })
}

export function stopSalesAssistant(
  request: typeof requestJson = requestJson
): Promise<SalesAssistantMe> {
  return request('/stop', salesAssistantMeSchema, { method: 'POST' })
}

export function startSalesAssistant(
  request: typeof requestJson = requestJson
): Promise<SalesAssistantMe> {
  return request('/start', salesAssistantMeSchema, { method: 'POST' })
}

export function deleteSalesAssistant(
  request: typeof requestJson = requestJson
): Promise<SalesAssistantMe> {
  return request('/me', salesAssistantMeSchema, { method: 'DELETE' })
}
