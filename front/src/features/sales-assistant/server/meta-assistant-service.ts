import 'server-only'
import ApiClient, { ApiError } from '@/lib/fetch/api-client'
import { UNAVAILABLE_BODY } from '@/shared/lib/bff/upstream-optional'
import type {
  AssistantServiceCall,
  AssistantServiceResult,
} from './assistant-service'
import { bffError, bffJson, isServiceErrorBody } from './bff-http'
import { metaRelaunchCookie } from './meta-oauth-relaunch'
import type { AssistantRequestServices } from './service-context'
import { relayAssistantStream } from './stream-relay'

const HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'sa-meta-assistant-service',
  'sa-meta-assistant-service.saleads.svc.cluster.local',
  // Modo local (ale-jolly, cambio 2 permitido del plan §4): ale-runtime en la red `ale`.
  'ale-runtime',
])
const DEV_CONTROL_BASE = 'https://gateway-dev.saleads.ai/api/meta-assistant'

/** Private Meta base: an origin or the approved JWT control prefix, never browser input. */
export function metaAssistantServiceOrigin(): string | null {
  try {
    const raw = (process.env.META_ASSISTANT_SERVICE_URL ?? '').trim()
    // Inspect the original path before URL can normalize traversal or backslashes.
    const match = raw.match(/^https?:\/\/[^/?#\\]+(\/[^?#\\]*)?$/i)
    if (!match) return null
    const url = new URL(raw)
    if (url.username || url.password) return null
    const allowed =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && HTTP_HOSTS.has(url.hostname))
    if (!allowed) return null
    const path = match[1] ?? '/'
    if (path === '/') return url.origin
    const base = `${url.origin}${path.replace(/\/$/, '')}`
    return base === DEV_CONTROL_BASE ? base : null
  } catch {
    return null
  }
}

function failure(error: unknown): Response {
  if (!(error instanceof ApiError)) return bffError(503, 'SERVICE_UNAVAILABLE')
  if (isServiceErrorBody(error.data)) {
    return bffError(
      error.status >= 500 ? 503 : error.status,
      error.data.code,
      error.data.request_id
    )
  }
  return error.status === 401
    ? bffError(401, 'UNAUTHORIZED')
    : bffError(503, 'SERVICE_UNAVAILABLE')
}

function send<T>(
  client: ApiClient,
  call: AssistantServiceCall<T>
): Promise<unknown> {
  const options = {
    headers: call.headers,
    timeout: call.timeoutMs ?? 15_000,
    cache: 'no-store' as const,
    redirect: 'error' as const,
  }
  switch (call.method) {
    case 'GET':
      return client.get(call.path, options)
    case 'POST':
      return client.post(call.path, call.body, options)
    case 'PUT':
      return client.put(call.path, call.body, options)
    case 'DELETE':
      return client.delete(call.path, options)
  }
}

async function callMeta<T>(
  client: ApiClient,
  call: AssistantServiceCall<T>
): Promise<AssistantServiceResult<T>> {
  try {
    const parsed = call.schema.safeParse(await send(client, call))
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, response: bffError(503, 'SERVICE_UNAVAILABLE') }
  } catch (error) {
    return { ok: false, response: failure(error) }
  }
}

async function optional<T>(
  client: ApiClient,
  call: AssistantServiceCall<T>
): Promise<Response> {
  try {
    const parsed = call.schema.safeParse(await send(client, call))
    return parsed.success
      ? bffJson({ available: true, data: parsed.data })
      : bffError(503, 'SERVICE_UNAVAILABLE')
  } catch (error) {
    if (
      error instanceof ApiError &&
      [404, 501].includes(error.status) &&
      !isServiceErrorBody(error.data)
    )
      return bffJson(UNAVAILABLE_BODY)
    return failure(error)
  }
}

/** No shared token, global destination switch or fallback to the classic VM. */
export function createMetaAssistantService(
  accessToken: string
): AssistantRequestServices {
  const base = metaAssistantServiceOrigin()
  if (!base) throw new Error('Meta service configuration unavailable')
  const client = new ApiClient(base)
  client.setAuthToken(accessToken)
  return {
    call: input => callMeta(client, input),
    relay: async input => {
      const result = await callMeta(client, input)
      return result.ok ? bffJson(result.data) : result.response
    },
    optional: input => optional(client, input),
    stream: input =>
      relayAssistantStream({ ...input, accessToken }, `${base}${input.path}`),
    activationCookie: metaRelaunchCookie,
  }
}
