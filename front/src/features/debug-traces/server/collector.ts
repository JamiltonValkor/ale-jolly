import 'server-only'

import { getSession } from '@/lib/auth/auth'
import { isUsableSession } from '@/lib/auth/session-health'
import type { ExtendedSession } from '@/types/auth'
import type { TraceEnvironment } from '../types'

const DEBUG_ROLE = 'observability_debug'
const SAFE_LOGICAL_ID = /^[A-Za-z0-9._~:@!$&'()*+,;=/-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEARCH_FILTERS = new Set([
  'environment',
  'serviceName',
  'result',
  'businessId',
  'correlationId',
  'traceId',
  'startAt',
  'endAt',
  'cursor',
  'limit',
])
const STREAM_FILTERS = new Set([
  'environment',
  'serviceName',
  'result',
  'businessId',
  'correlationId',
  'traceId',
])

export interface TraceLocalAccess {
  session: ExtendedSession
  environment: TraceEnvironment
}

export interface TraceAccess extends TraceLocalAccess {
  collectorUrl: string
  token: string
  apiPrefix: '/api/internal' | '/api/observability'
}

export interface TracePageAccess {
  localExportAllowed: boolean
  remoteAccess: TraceAccess | Response
}

function normalizeEnvironment(
  value: string | undefined
): TraceEnvironment | null {
  switch (value?.trim().toLowerCase()) {
    case 'local':
      return 'local'
    case 'dev':
    case 'develop':
    case 'development':
      return 'dev'
    case 'preprod':
    case 'preproduction':
      return 'preprod'
    default:
      return null
  }
}

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

export async function authorizeLocalTraceAccess(options?: {
  requireDebugRole?: boolean
}): Promise<TraceLocalAccess | Response> {
  if (process.env.TRACE_VIEWER_ENABLED !== 'true') {
    return errorResponse(404, 'Not Found')
  }
  const environment = normalizeEnvironment(
    process.env.TRACE_ENVIRONMENT ??
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NEXT_PUBLIC_ENVIRONMENT
  )
  if (!environment) return errorResponse(404, 'Not Found')

  const session = await getSession()
  if (
    !isUsableSession(session) ||
    typeof session.expiresAt !== 'number' ||
    !Number.isFinite(session.expiresAt) ||
    session.expiresAt <= Date.now()
  ) {
    return errorResponse(401, 'Unauthorized')
  }
  if (
    options?.requireDebugRole !== false &&
    !session.user.roles?.includes(DEBUG_ROLE)
  ) {
    return errorResponse(403, 'Forbidden')
  }

  return { session, environment }
}

async function authorizeCollectorAccess(
  local: TraceLocalAccess
): Promise<TraceAccess | Response> {
  const { session, environment } = local
  const token = (
    process.env.TRACE_COLLECTOR_TOKEN ??
    process.env.INTERNAL_API_TOKEN ??
    ''
  ).trim()
  if (!token) return errorResponse(503, 'Trace collector unavailable')

  const collectorUrl = (
    process.env.TRACE_COLLECTOR_URL ??
    process.env.URL_ERROR_LOGGING_SERVICE ??
    'http://error-logging-service.saleads.svc.cluster.local:3005'
  ).replace(/\/+$/, '')

  const configuredPrefix =
    process.env.TRACE_COLLECTOR_PATH_PREFIX?.trim() || '/api/internal'
  if (
    configuredPrefix !== '/api/internal' &&
    configuredPrefix !== '/api/observability'
  ) {
    return errorResponse(503, 'Trace collector unavailable')
  }
  const apiPrefix: TraceAccess['apiPrefix'] = configuredPrefix
  if (apiPrefix === '/api/observability' && !session.accessToken?.trim()) {
    return errorResponse(401, 'Unauthorized')
  }

  return { session, environment, collectorUrl, token, apiPrefix }
}

export async function authorizeTraceAccess(options?: {
  requireDebugRole?: boolean
}): Promise<TraceAccess | Response> {
  const local = await authorizeLocalTraceAccess(options)
  return isAccessResponse(local) ? local : authorizeCollectorAccess(local)
}

/** Authenticates once, then reports remote collector availability separately from local export permission. */
export async function authorizeTracePageAccess(): Promise<TracePageAccess> {
  const local = await authorizeLocalTraceAccess()
  if (isAccessResponse(local))
    return { localExportAllowed: false, remoteAccess: local }
  return {
    localExportAllowed: true,
    remoteAccess: await authorizeCollectorAccess(local),
  }
}

export function isAccessResponse(
  value: TraceLocalAccess | TraceAccess | Response
): value is Response {
  return value instanceof Response
}

export function isSafeCorrelationId(value: string): boolean {
  return SAFE_LOGICAL_ID.test(value)
}

export function collectorHeaders(
  access: TraceAccess,
  extra?: HeadersInit
): Headers {
  const headers = new Headers(extra)
  headers.set('x-internal-api-token', access.token)
  headers.set(
    'x-authenticated-roles',
    JSON.stringify(access.session.user.roles ?? [])
  )
  if (UUID.test(access.session.user.id)) {
    headers.set('x-authenticated-user-id', access.session.user.id)
  }
  return headers
}

export function filteredQuery(
  source: URLSearchParams,
  kind: 'search' | 'stream'
): string {
  const allowed = kind === 'search' ? SEARCH_FILTERS : STREAM_FILTERS
  const output = new URLSearchParams()
  for (const [key, value] of source) {
    if (allowed.has(key) && value.length <= 512) output.append(key, value)
  }
  const query = output.toString()
  return query ? `?${query}` : ''
}

export async function collectorFetch(
  access: TraceAccess,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const finalPath =
    path === '/api/internal' || path.startsWith('/api/internal/')
      ? access.apiPrefix + path.slice('/api/internal'.length)
      : path

  const headers = collectorHeaders(access, init.headers)

  if (access.apiPrefix === '/api/observability') {
    headers.set('Authorization', `Bearer ${access.session.accessToken}`)
  }

  return fetch(`${access.collectorUrl}${finalPath}`, {
    ...init,
    headers,
    cache: 'no-store',
  })
}

export async function passthroughJson(response: Response): Promise<Response> {
  const body = await response.text()
  return new Response(body, {
    status: response.status,
    headers: {
      'content-type':
        response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  })
}

export function sanitizedIdentity(
  session: ExtendedSession
): string | undefined {
  return UUID.test(session.user.id) ? session.user.id.toLowerCase() : undefined
}
