/**
 * Server Gateway Client
 *
 * Server-side only API client for use in Server Actions and Server Components.
 * Resolves the X-Business-Id gap: gatewayClient reads from localStorage (null on server).
 * This helper accepts businessId explicitly as a parameter.
 *
 * Uses auth() from next-auth for fresh token on every request (no client-side caching).
 *
 * @example
 * ```ts
 * 'use server'
 * import { serverGateway } from '@/lib/fetch/server-gateway'
 *
 * export async function createBusinessAction(name: string) {
 *   const result = await serverGateway.post('/api/businesses', { business_name: name })
 *   return result
 * }
 *
 * export async function getCampaigns(businessId: string) {
 *   const result = await serverGateway.get('/api/campaigns', { businessId })
 *   return result
 * }
 * ```
 *
 * @see src/lib/fetch/gateway-client.ts - Client-side counterpart
 * @see .claude/rules/server-actions.md
 */

import {
  transportErrorCode,
  type TransportErrorCode,
} from '@/lib/http/network-error-code'
import { auth } from '@/auth'
import * as Sentry from '@sentry/nextjs'
import { isUsableSession } from '@/lib/auth/session-health'
import { parseRetryAfterSeconds } from '@/lib/http/retry-after'
import { readBoundedResponse } from '@/lib/http/read-bounded-response'
import { headers as requestHeaders } from 'next/headers'
import {
  sanitizeTraceIdentifier,
  withTraceHeaders,
} from '@/shared/observability/trace-context'
import {
  emitServerGatewayTrace,
  isServerTraceCaptureEnabled,
  type ServerGatewayTraceInput,
} from '@/lib/observability/server-trace-events'
import { clientTraceRouteTemplate } from '@/shared/observability/debug-trace-contract'
import { logStrategyResponse } from './strategy-response-diagnostics'

const GATEWAY_URL =
  process.env.GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  'http://localhost:8765'

/**
 * Optional local computer-support backend for hybrid debug. When set, only
 * `/api/support/**` and `/api/checklist/**` calls bypass the gateway and hit
 * the local FastAPI process (see sa-computer-support-backend); every other
 * endpoint keeps using the gateway. Unset in every deployed environment.
 */
const SUPPORT_BACKEND_URL = (
  process.env.SUPPORT_BACKEND_URL ||
  process.env.NEXT_PUBLIC_SUPPORT_BACKEND_URL ||
  ''
).replace(/\/+$/, '')

const SUPPORT_ENDPOINT_PATTERN = /^\/api\/(support|checklist)(\/|$)/
const TRACE_HEADER_NAMES = [
  'x-correlation-id',
  'x-request-id',
  'x-request-attempt',
  'traceparent',
] as const

function resolveBaseUrl(endpoint: string): string {
  if (SUPPORT_BACKEND_URL && SUPPORT_ENDPOINT_PATTERN.test(endpoint)) {
    return SUPPORT_BACKEND_URL
  }
  return GATEWAY_URL
}

export interface ServerRequestDiagnostics {
  category:
    | 'http'
    | 'transport'
    | 'timeout'
    | 'cancelled'
    | 'contract'
    | 'authentication'
  phase: 'authorization' | 'request' | 'response'
  method: string
  endpoint: string
  traceRoute?: string
  durationMs: number
  correlationId: string
  requestId: string
  attempt: number
  traceId?: string
  spanId?: string
  parentSpanId?: string
  upstreamRequestId?: string
  transportCode?: TransportErrorCode
  upstreamStatus?: number
  upstreamCode?: string
}

class ServerApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public data?: unknown,
    public retryAfterSeconds?: number,
    public diagnostics?: ServerRequestDiagnostics
  ) {
    super(`API Error: ${status} ${statusText}`)
    this.name = 'ServerApiError'
  }
}

export class ServerRequestError extends Error {
  constructor(public readonly diagnostics: ServerRequestDiagnostics) {
    super(
      diagnostics.category === 'timeout'
        ? 'Request timeout'
        : diagnostics.category === 'cancelled'
          ? 'Request cancelled'
          : diagnostics.category === 'contract'
            ? 'Invalid API response'
            : 'API transport unavailable'
    )
    this.name =
      diagnostics.category === 'cancelled' ? 'AbortError' : 'ServerRequestError'
  }
}

interface ServerFetchOptions {
  /** Opt-in exact success status for strict mutation receipts. */
  expectedStatus?: number
  params?: Record<string, string | number | boolean>
  timeout?: number
  businessId?: string
  headers?: Record<string, string>
  skipAuth?: boolean
  sentryTag?: string
  signal?: AbortSignal
  /** Static route template for an endpoint whose identifiers cannot be inferred. */
  diagnosticEndpoint?: string
  /** Opt-in bound for narrow public read projections; default consumers are unchanged. */
  maxResponseBytes?: number
  /** Opt-in, parsed Retry-After seconds only; never exposes raw response headers. */
  onRetryAfter?: (seconds: number) => void
}

interface ServerGatewayRequest {
  endpoint: string
  method: string
  body?: unknown
  options: ServerFetchOptions
  url: string
  timeout: number
}

type ServerGatewaySpan = NonNullable<ReturnType<typeof Sentry.getActiveSpan>>

/**
 * Get auth token from server-side session (fresh per request)
 */
async function getServerToken(): Promise<string> {
  try {
    const session = await auth()
    if (isUsableSession(session)) return session.accessToken
  } catch {
    // Session reads fail closed below with the same controlled auth error.
  }

  throw new ServerApiError(401, 'Unauthorized', {
    code: 'AUTH_SESSION_UNUSABLE',
  })
}

/**
 * Build URL with query parameters
 */
function buildUrl(
  endpoint: string,
  params?: Record<string, string | number | boolean>
): string {
  const url = `${resolveBaseUrl(endpoint)}${endpoint}`

  if (!params) return url

  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value))
    }
  }

  const queryString = searchParams.toString()
  if (!queryString) return url

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${queryString}`
}

function buildHeaders(options: ServerFetchOptions): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  }
  const trace = withTraceHeaders(baseHeaders)
  return {
    ...Object.fromEntries(
      Object.entries(baseHeaders).filter(
        ([key]) =>
          !/^(x-correlation-id|x-request-id|x-request-attempt|traceparent)$/i.test(
            key
          )
      )
    ),
    'X-Correlation-Id': trace.correlationId,
    'X-Request-Id': trace.requestId,
    'X-Request-Attempt': String(trace.attempt),
    traceparent: trace.headers.get('traceparent')!,
  }
}

async function sendRequest(
  request: ServerGatewayRequest,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  signal.throwIfAborted()
  if (request.options.skipAuth !== true) {
    const token = await getServerToken()
    headers['Authorization'] = `Bearer ${token}`
  }

  if (request.options.businessId) {
    headers['X-Business-Id'] = request.options.businessId
  }

  signal.throwIfAborted()

  return fetch(request.url, {
    method: request.method,
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
    signal,
    cache: 'no-store',
  })
}

async function responseText(
  response: Response,
  maxBytes?: number
): Promise<string> {
  if (maxBytes === undefined) return response.text()
  try {
    return await readBoundedResponse(response, maxBytes)
  } catch {
    throw new ServerApiError(503, 'Unavailable', {
      error: { code: 'WORKSPACE_UNAVAILABLE' },
    })
  }
}

async function createApiError(
  response: Response,
  maxBytes?: number
): Promise<ServerApiError> {
  const text = await responseText(response, maxBytes)
  let errorData: unknown
  try {
    errorData = JSON.parse(text)
  } catch {
    errorData = text || `Error ${response.status}: ${response.statusText}`
  }

  return new ServerApiError(
    response.status,
    response.statusText,
    errorData,
    parseRetryAfterSeconds(response.headers.get('retry-after'))
  )
}

const RESOURCE_COLLECTIONS = new Set([
  'businesses',
  'conversations',
  'plans',
  'drafts',
  'operations',
  'executions',
  'jobs',
  'products',
  'services',
  'campaigns',
  'adsets',
  'ads',
  'assets',
  'pieces',
  'proposals',
  'versions',
  'accounts',
  'connections',
  'sessions',
  'runs',
])
const RESOURCE_ACTIONS = new Set([
  'approvals',
  'cost',
  'runs',
  'attach',
  'library',
  'slots',
  'draft-manifest',
  'draft-manifests',
  'materialize',
  'by-source',
  'by-execution',
  'by-session',
  'by-command',
  'current',
  'selected',
  'start',
  'create',
  'list',
  'search',
  'status',
  'active',
  'available',
  'eligible',
  'batch',
  'bulk',
  'preview',
])
const ROUTE_SEGMENTS = new Set([
  'validation',
  'transactions',
  'decision',
  'api',
  'business-intelligence',
  'agent-chat',
  'agent-conversations',
  'strategy',
  'integration',
  'draft-campaign',
  'support',
  'checklist',
  'subscription',
  'credits',
  'auth',
  'live',
  'token',
  'wizard',
  'wizard-state-v2',
  'wizard-draft',
  'promote',
  'redo',
  'turns',
  'answers',
  'cancel',
  'confirm',
  'approve',
  'review',
  'launch',
  'preflight',
  'publish',
  'resume',
  'rollback',
  'retry',
  'events',
  'state',
  'config',
  'configuration',
  'platforms',
  'meta',
  'facebook',
  'instagram',
  'dna',
  'scrape-url',
  'gen-image',
  'eligible-posts',
  'plan',
  'business',
  'metrics',
  'growth-cycle',
  'growth-cycles',
  'activity',
  'first-launch',
  'inventory',
  'page-selection',
  'candidate1-availability',
  'business-managers',
  'pages',
  'ad-accounts',
  'capabilities',
  'destination-capabilities',
  'connection',
  'subscription',
  'credits',
  'costs',
  'balance',
  'check',
  'packs',
  'purchases',
  'catalog',
  'summary',
  'generate',
  'copies',
  'creatives',
  'library',
  'eligibility',
  'readiness',
])

/** Templates retain routing information, never query values or resource IDs. */
function diagnosticEndpoint(endpoint: string, template = false): string {
  const path = endpoint.split(/[?#]/)[0]
  if (!path.startsWith('/') || path.startsWith('//')) return '/:unknown'
  const segments = path.split('/')
  return segments
    .map((segment, index) => {
      if (!segment || /^:[a-z_]+$/i.test(segment)) return segment
      if (
        RESOURCE_COLLECTIONS.has(segments[index - 1]) &&
        !RESOURCE_ACTIONS.has(segment)
      )
        return ':id'
      return (ROUTE_SEGMENTS.has(segment) ||
        RESOURCE_COLLECTIONS.has(segment) ||
        RESOURCE_ACTIONS.has(segment) ||
        /^v\d{1,2}$/.test(segment) ||
        template) &&
        /^[a-z][a-z0-9_-]{0,63}$/i.test(segment) &&
        !/^[a-f\d]{16,}$/i.test(segment) &&
        !/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(segment)
        ? segment
        : ':id'
    })
    .join('/')
}

function recordSafely(record: () => void): void {
  try {
    record()
  } catch {
    /* Observability must not change request outcomes. */
  }
}

function recordSuccess(
  span: ServerGatewaySpan | undefined,
  diagnostics: ServerRequestDiagnostics,
  domainFailure: boolean,
  domainReason?: ServerGatewayTraceInput['reason']
) {
  recordSafely(() =>
    emitServerGatewayTrace({
      correlationId: diagnostics.correlationId,
      requestId: diagnostics.requestId,
      traceId: diagnostics.traceId ?? '',
      spanId: diagnostics.spanId ?? '',
      parentSpanId: diagnostics.parentSpanId,
      attempt: diagnostics.attempt,
      phase: 'http.response',
      result: domainFailure ? 'error' : 'success',
      state: domainFailure ? 'failed' : 'complete',
      ...(domainFailure
        ? { reason: domainReason ?? 'domain_rejected', errorCode: 'HTTP_ERROR' }
        : {}),
      method: diagnostics.method,
      route: diagnostics.traceRoute ?? diagnostics.endpoint,
      statusCode: diagnostics.upstreamStatus,
      durationMs: diagnostics.durationMs,
    })
  )
  recordSafely(() => {
    span?.setStatus({ code: 1, message: 'ok' })
    span?.setAttribute('http.status_code', diagnostics.upstreamStatus!)
    Sentry.addBreadcrumb({
      category: 'http',
      type: 'http',
      level: 'info',
      message: `${diagnostics.method} ${diagnostics.endpoint}`,
      data: diagnostics,
    })
  })
}

function isDomainFailureEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const success = Object.getOwnPropertyDescriptor(value, 'success')
    return Boolean(success && 'value' in success && success.value === false)
  } catch {
    return false
  }
}

function serverApiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ServerApiError)) return undefined
  return ownString(error.data, 'code') ?? ownString(error.data, 'error')
}

async function parseResponse<T>(
  response: Response,
  maxBytes?: number
): Promise<T> {
  if (maxBytes !== undefined)
    return JSON.parse(await responseText(response, maxBytes)) as T
  const contentType = response.headers.get('content-type')
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text()
    return (text || null) as T
  }

  return await response.json()
}

function captureFailure(
  request: ServerGatewayRequest,
  diagnostics: ServerRequestDiagnostics
) {
  recordSafely(() =>
    Sentry.captureException(new Error('Gateway request failed'), {
      tags: {
        ...(request.options.sentryTag
          ? { action: request.options.sentryTag }
          : {}),
        api_endpoint: diagnostics.endpoint,
        http_method: diagnostics.method,
        error_type:
          diagnostics.category === 'http' ? 'api_error' : diagnostics.category,
        context: 'server_action',
      },
      extra: { ...diagnostics, status: diagnostics.upstreamStatus },
      level: (diagnostics.upstreamStatus ?? 0) >= 500 ? 'error' : 'warning',
    })
  )
}

function upstreamCode(error: unknown): string | undefined {
  const data = error instanceof ServerApiError ? error.data : undefined
  if (!data || typeof data !== 'object' || !('code' in data)) return undefined
  return typeof data.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(data.code)
    ? data.code
    : undefined
}

function ownString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor &&
      'value' in descriptor &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

function knownDomainReason(
  code: string | undefined,
  route: string | undefined
): ServerGatewayTraceInput['reason'] {
  if (
    code === 'BILLING_REVISION_CONFLICT' &&
    route === '/api/subscription/billing/account/identity'
  )
    return 'identity_revision_conflict'
  if (
    route === '/api/agent-chat/live-budget' ||
    route?.startsWith('/api/campaigns/agentic/v1/budget-')
  ) {
    if (code === 'BUDGET_MODE_NOT_SUPPORTED') return 'budget_unsupported'
    if (code === 'LIVE_BUDGET_UNAVAILABLE') return 'budget_unavailable'
    if (code === 'BUDGET_SNAPSHOT_CONFLICT') return 'budget_rejected'
  }
  return undefined
}

function domainFailureCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const success = Object.getOwnPropertyDescriptor(value, 'success')
  if (!success || !('value' in success) || success.value !== false)
    return undefined
  return ownString(value, 'code') ?? ownString(value, 'error')
}

function traceLineage(headers: Record<string, string>, source?: HeadersInit) {
  const [, traceId, spanId] = headers.traceparent.split('-')
  const parent = new Headers(source)
    .get('traceparent')
    ?.trim()
    .match(/^00-([a-f\d]{32})-([a-f\d]{16})-[a-f\d]{2}$/i)
  const parentSpanId =
    parent?.[1].toLowerCase() === traceId && parent[2] !== '0'.repeat(16)
      ? parent[2].toLowerCase()
      : undefined
  return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}) }
}

function requestDiagnostics(
  request: ServerGatewayRequest,
  headers: Record<string, string>,
  startedAt: number,
  response: Response | undefined,
  category: ServerRequestDiagnostics['category'],
  error?: unknown
): ServerRequestDiagnostics {
  const upstreamRequestId = sanitizeTraceIdentifier(
    response?.headers.get('x-request-id')
  )
  const code = response ? upstreamCode(error) : undefined
  return {
    category,
    phase:
      category === 'authentication'
        ? 'authorization'
        : response
          ? 'response'
          : 'request',
    method: request.method,
    endpoint: diagnosticEndpoint(
      request.options.diagnosticEndpoint ?? request.endpoint,
      Boolean(request.options.diagnosticEndpoint)
    ),
    traceRoute: clientTraceRouteTemplate(
      request.options.diagnosticEndpoint ?? request.endpoint
    ),
    durationMs: Math.max(0, Date.now() - startedAt),
    correlationId: headers['X-Correlation-Id'],
    requestId: headers['X-Request-Id'],
    attempt: Number(headers['X-Request-Attempt']) || 1,
    ...traceLineage(headers, request.options.headers),
    ...(response ? { upstreamStatus: response.status } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    ...(code ? { upstreamCode: code } : {}),
    ...(category === 'transport'
      ? { transportCode: transportErrorCode(error) }
      : {}),
  }
}

function recordRequestFailure(
  error: unknown,
  request: ServerGatewayRequest,
  diagnostics: ServerRequestDiagnostics,
  span?: ServerGatewaySpan
): Error {
  const semanticReason = knownDomainReason(
    serverApiErrorCode(error) ?? diagnostics.upstreamCode,
    diagnostics.traceRoute
  )
  const reason =
    diagnostics.category === 'cancelled'
      ? 'provider_cancelled'
      : diagnostics.category === 'authentication'
        ? 'permission_denied'
        : diagnostics.category === 'http' && semanticReason
          ? semanticReason
          : diagnostics.category === 'http' &&
              diagnostics.upstreamCode === 'SERVER_ACTION_STALE'
            ? 'server_action_stale'
            : diagnostics.category === 'http' ||
                diagnostics.category === 'contract'
              ? 'domain_rejected'
              : 'provider_unavailable'
  const errorCode =
    diagnostics.category === 'cancelled'
      ? 'REQUEST_ABORTED'
      : diagnostics.category === 'contract'
        ? 'INVALID_RESPONSE'
        : diagnostics.category === 'transport' ||
            diagnostics.category === 'timeout'
          ? 'NETWORK_ERROR'
          : diagnostics.category === 'http' &&
              diagnostics.upstreamCode === 'SERVER_ACTION_STALE'
            ? 'SERVER_ACTION_STALE'
            : 'HTTP_ERROR'
  recordSafely(() =>
    emitServerGatewayTrace({
      correlationId: diagnostics.correlationId,
      requestId: diagnostics.requestId,
      traceId: diagnostics.traceId ?? '',
      spanId: diagnostics.spanId ?? '',
      parentSpanId: diagnostics.parentSpanId,
      attempt: diagnostics.attempt,
      phase: 'http.error',
      result: 'error',
      state:
        diagnostics.category === 'cancelled'
          ? 'cancelled'
          : diagnostics.category === 'http' ||
              diagnostics.category === 'authentication' ||
              diagnostics.category === 'contract'
            ? 'failed'
            : 'unavailable',
      reason,
      errorCode,
      method: diagnostics.method,
      route: diagnostics.traceRoute ?? diagnostics.endpoint,
      statusCode: diagnostics.upstreamStatus,
      durationMs: diagnostics.durationMs,
    })
  )
  recordSafely(() =>
    span?.setStatus({
      code: diagnostics.category === 'cancelled' ? 0 : 2,
      message: diagnostics.category,
    })
  )
  if (diagnostics.category !== 'cancelled') {
    recordSafely(() =>
      Sentry.addBreadcrumb({
        category: 'http',
        type: 'http',
        level: 'error',
        message: `${diagnostics.method} ${diagnostics.endpoint} FAILED`,
        data: diagnostics,
      })
    )
    captureFailure(request, diagnostics)
    recordSafely(() =>
      logStrategyResponse({
        ...diagnostics,
        status: diagnostics.upstreamStatus,
        transportError: diagnostics.category,
      })
    )
  }
  if (
    error instanceof ServerApiError &&
    (diagnostics.category === 'http' ||
      diagnostics.category === 'authentication')
  ) {
    error.diagnostics = diagnostics
    return error
  }
  return new ServerRequestError(diagnostics)
}

function failureCategory(
  error: unknown,
  received: Response | undefined,
  caller: AbortSignal | undefined,
  timeout: AbortSignal
): ServerRequestDiagnostics['category'] {
  if (caller?.aborted) return 'cancelled'
  if (timeout.aborted) return 'timeout'
  if (error instanceof ServerApiError)
    return received ? 'http' : 'authentication'
  return received && error instanceof SyntaxError ? 'contract' : 'transport'
}

async function executeRequest<T>(
  request: ServerGatewayRequest,
  span?: ServerGatewaySpan
): Promise<T> {
  const headers = buildHeaders(request.options)
  const controller = new AbortController()
  const signal = request.options.signal
    ? AbortSignal.any([controller.signal, request.options.signal])
    : controller.signal
  const timeoutId = setTimeout(() => controller.abort(), request.timeout)
  const startedAt = Date.now()
  let received: Response | undefined

  try {
    const response = await sendRequest(request, headers, signal)
    received = response
    signal.throwIfAborted()
    if (!response.ok)
      throw await createApiError(response, request.options.maxResponseBytes)
    if (
      request.options.expectedStatus !== undefined &&
      response.status !== request.options.expectedStatus
    )
      throw new ServerApiError(502, 'Unexpected response status', {
        code: 'UPSTREAM_CONTRACT_MISMATCH',
      })
    const result = await parseResponse<T>(
      response,
      request.options.maxResponseBytes
    )
    signal.throwIfAborted()
    const retryAfter = parseRetryAfterSeconds(
      response.headers.get('retry-after')
    )
    if (retryAfter !== undefined) request.options.onRetryAfter?.(retryAfter)
    const diagnostics = requestDiagnostics(
      request,
      headers,
      startedAt,
      response,
      'http'
    )
    const domainFailure = isDomainFailureEnvelope(result)
    recordSuccess(
      span,
      diagnostics,
      domainFailure,
      domainFailure
        ? knownDomainReason(domainFailureCode(result), diagnostics.traceRoute)
        : undefined
    )
    return result
  } catch (error) {
    const category = failureCategory(
      error,
      received,
      request.options.signal,
      controller.signal
    )
    const diagnostics = requestDiagnostics(
      request,
      headers,
      startedAt,
      received,
      category,
      error
    )
    throw recordRequestFailure(error, request, diagnostics, span)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Main server-side request function
 */
async function request<T>(
  endpoint: string,
  method: string,
  body?: unknown,
  options: ServerFetchOptions = {}
): Promise<T> {
  let requestOptions = options
  if (isServerTraceCaptureEnabled()) {
    try {
      const inbound = await requestHeaders()
      const explicitHeaders = new Headers(options.headers)
      const mergedHeaders = { ...options.headers }
      for (const name of TRACE_HEADER_NAMES) {
        const value = inbound.get(name)
        if (value && !explicitHeaders.has(name)) mergedHeaders[name] = value
      }
      requestOptions = { ...options, headers: mergedHeaders }
    } catch {
      // Background/server contexts may not have an incoming HTTP request.
    }
  }
  const serverRequest: ServerGatewayRequest = {
    endpoint,
    method,
    body,
    options: requestOptions,
    url: buildUrl(endpoint, requestOptions.params),
    timeout:
      requestOptions.timeout === undefined ? 30000 : requestOptions.timeout,
  }

  const route = diagnosticEndpoint(
    requestOptions.diagnosticEndpoint ?? endpoint,
    Boolean(requestOptions.diagnosticEndpoint)
  )
  let operation: Promise<T> | undefined
  try {
    return await Sentry.startSpan(
      {
        name: `${method} ${route}`,
        op: 'http.client',
        attributes: {
          'http.method': method,
          'http.url': route,
          'http.client': 'serverGateway',
        },
      },
      span => (operation = executeRequest<T>(serverRequest, span))
    )
  } catch {
    // Reuse the started operation even if the span failed after starting it.
    if (operation) return operation
    return executeRequest<T>(serverRequest)
  }
}

/**
 * Server Gateway Client
 *
 * All methods accept an optional `options.businessId` to inject X-Business-Id header.
 * Auth token is obtained server-side via `auth()` on every request.
 */
export const serverGateway = {
  async get<T>(endpoint: string, options?: ServerFetchOptions): Promise<T> {
    return request<T>(endpoint, 'GET', undefined, options)
  },

  async post<T>(
    endpoint: string,
    data?: unknown,
    options?: ServerFetchOptions
  ): Promise<T> {
    return request<T>(endpoint, 'POST', data, options)
  },

  async put<T>(
    endpoint: string,
    data?: unknown,
    options?: ServerFetchOptions
  ): Promise<T> {
    return request<T>(endpoint, 'PUT', data, options)
  },

  async patch<T>(
    endpoint: string,
    data?: unknown,
    options?: ServerFetchOptions
  ): Promise<T> {
    return request<T>(endpoint, 'PATCH', data, options)
  },

  async delete<T>(endpoint: string, options?: ServerFetchOptions): Promise<T> {
    return request<T>(endpoint, 'DELETE', undefined, options)
  },
}

/**
 * Absolute gateway URL for an endpoint, resolved exactly like `serverGateway`.
 * For streaming relays (SSE) that must hand the raw `Response.body` to the
 * browser instead of parsing it.
 */
export function buildServerGatewayUrl(endpoint: string): string {
  return buildUrl(endpoint)
}

export { ServerApiError }
export default serverGateway
