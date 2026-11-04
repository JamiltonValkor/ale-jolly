export type ClientTraceResult =
  | 'started'
  | 'success'
  | 'error'
  | 'partial'
  | 'retry'
  | 'dropped'

/** Closed vocabulary projected into the existing TraceEventV1 collector contract. */
export const CLIENT_TRACE_OPERATIONS = [
  'http_request',
  'navigation',
  'dom_action',
  'react_query',
  'agent_chat_turn',
  'agent_chat_stream',
  'agent_chat_tool',
  'agent_chat_continuation',
  'agent_chat_cancel',
  'meta_oauth',
  'billing',
  'budget',
  'library',
  'notification',
  'runtime_error',
  'error_boundary',
  'unknown',
] as const
export type ClientTraceOperation = (typeof CLIENT_TRACE_OPERATIONS)[number]

export const CLIENT_TRACE_COMPONENTS = [
  'agent_chat',
  'campaign_panel',
  'meta',
  'grok',
  'billing',
  'budget',
  'library',
  'notification',
  'navigation',
  'query',
  'runtime',
  'unknown',
] as const
export type ClientTraceComponent = (typeof CLIENT_TRACE_COMPONENTS)[number]

export const CLIENT_TRACE_REASONS = [
  'permission_read_denied',
  'panel_context_missing',
  'panel_context_rejected',
  'source_message_rejected',
  'reference_new_rejected',
  'reference_history_rejected',
  'tool_input_invalid',
  'tool_budget_exhausted',
  'terminal_empty',
  'oauth_closed',
  'build_stale',
  'provider_cancelled',
  'provider_unavailable',
  'identity_revision_conflict',
  'notification_destination_unavailable',
  'notification_destination_missing',
  'notification_scope_mismatch',
  'budget_unsupported',
  'budget_unavailable',
  'budget_rejected',
  'server_action_stale',
  'permission_denied',
  'scope_mismatch',
  'library_reference_missing',
  'library_reference_not_image',
  'library_reference_limit',
  'library_upload_pending',
  'library_requires_prompt',
  'layer_escape_deferred',
  'empty_result',
  'unsupported',
  'domain_rejected',
  'unknown',
] as const
export type ClientTraceReason = (typeof CLIENT_TRACE_REASONS)[number]

export const CLIENT_TRACE_CAUSALITIES = ['explicit', 'unbound'] as const
export type ClientTraceCausality = (typeof CLIENT_TRACE_CAUSALITIES)[number]

export const CLIENT_TRACE_TRANSPORTS = [
  'fetch',
  'xhr',
  'sse',
  'query',
  'dom',
  'action',
  'runtime',
  'collector',
] as const
export type ClientTraceTransport = (typeof CLIENT_TRACE_TRANSPORTS)[number]

export const CLIENT_TRACE_DESTINATIONS = [
  'first_party',
  'third_party',
  'collector',
] as const
export type ClientTraceDestination = (typeof CLIENT_TRACE_DESTINATIONS)[number]

export const CLIENT_TRACE_PHASES = [
  'action.start',
  'action.end',
  'http.request',
  'http.response',
  'http.error',
  'stream.start',
  'stream.chunk',
  'stream.finish',
  'tool.start',
  'tool.finish',
  'turn.continue',
  'turn.cancel',
  'query.start',
  'query.end',
  'navigation.start',
  'dom.action',
  'runtime.error',
  'error.boundary',
] as const
export type ClientTracePhase = (typeof CLIENT_TRACE_PHASES)[number]

/** Domain states live in the typed projection; collector outcomes remain unchanged. */
export const CLIENT_TRACE_STATES = [
  'active',
  'complete',
  'failed',
  'cancelled',
  'blocked',
  'empty',
  'unsupported',
  'unconfirmed',
  'unavailable',
  'unbound',
] as const
export type ClientTraceState = (typeof CLIENT_TRACE_STATES)[number]

export const CLIENT_TRACE_ERROR_CODES = [
  'NETWORK_ERROR',
  'REQUEST_ABORTED',
  'HTTP_ERROR',
  'INVALID_RESPONSE',
  'SERVER_ACTION_STALE',
  'AGENT_CHAT_ERROR',
  'JS_RUNTIME_ERROR',
  'JS_REJECTION',
  'COLLECTOR_UNAVAILABLE',
  'SERIALIZATION_REJECTED',
  'RESOURCE_LOAD_ERROR',
] as const
export type ClientTraceErrorCode = (typeof CLIENT_TRACE_ERROR_CODES)[number]

export const CLIENT_TRACE_RESOURCE_TYPES = ['image', 'script', 'style'] as const
export type ClientTraceResourceType =
  (typeof CLIENT_TRACE_RESOURCE_TYPES)[number]

export const CLIENT_TRACE_ROUTES = [
  '/api/agent-chat/conversations',
  '/api/agent-chat/conversations/{id}',
  '/api/agent-chat/conversations/{id}/turns',
  '/api/agent-chat/conversations/{id}/interactions',
  '/api/agent-chat/conversations/{id}/answers',
  '/api/agent-chat/conversations/{id}/cancel',
  '/api/agent-chat/conversations/{id}/publication-references',
  '/api/agent-chat/live-budget',
  '/api/campaigns/agentic/v1/budget-redistributions',
  '/api/campaigns/agentic/v1/budget-redistributions/targets',
  '/api/campaigns/agentic/v1/budget-redistributions/preview',
  '/api/campaigns/agentic/v1/budget-redistributions/by-command/{id}',
  '/api/campaigns/agentic/v1/budget-adjustments',
  '/api/campaigns/agentic/v1/budget-adjustments/preview',
  '/api/subscription/billing/account/identity',
  '/api/subscription/billing/account/payment-method',
  '/api/subscription/billing/account/invoices',
  '/api/subscription/billing/account/documents/{id}',
  '/api/subscription/billing-portal',
  '/api/notification-preferences',
  '/api/notifications/{userId}/read-all',
  '/api/notifications/{userId}/{id}',
  '/api/notifications/{userId}/{id}/read',
  '/api/agent-chat/workspace-budget',
  '/api/agent-chat/library',
  '/api/agent-chat/library/verbo',
  '/api/agent-chat/library/uploads',
  '/api/agent-chat/library/uploads/complete',
  '/api/library/pieces',
  '/api/library/pieces/{id}',
  '/api/library/pieces/{id}/download',
  '/api/library/pieces/{id}/share',
  '/api/integration/meta/oauth/start',
  '/api/integration/meta/oauth/url',
  '/api/integration/meta/oauth/secondary/url',
  '/api/integration/meta/save-configuration',
  '/api/integration/meta/disconnect',
  '/api/integration/meta/create-ad-account',
  '/api/integration/meta/create-pixel',
  '/api/integration/meta/refresh-token',
  '/api/integration/meta/targeting/validate',
  '/api/integration/meta/first-launch/page-selection',
  '/api/integration/meta/connection',
  '/api/integration/meta/oauth/attempts/{id}/confirm',
  '/api/integration/meta/oauth/attempts/{id}/status',
  '/api/agent-chat/meta/oauth-url',
  '/api/agent-chat/oauth/start',
  '/api/agent-chat/oauth/attempt',
  '/api/agent-chat/oauth/poll',
  '/api/agent-chat/ai-connections/{provider}/oauth/start',
  '/api/agent-chat/ai-connections/{provider}/oauth/attempt',
  '/api/sales-assistant/businesses/{id}/agent-budget',
  '/api/autonomous-team/credit-cap',
  '/api/agent-chat/individual-campaign',
  '/api/agent-chat/launch',
  '/[locale]/dashboard/connected-accounts',
  '/[locale]/dashboard/library',
  '/[locale]/dashboard/debug/traces',
  '/[locale]/dashboard/strategies/draft/{id}',
  '/[locale]',
  '/[locale]/auth/signin',
  '/[locale]/actions/notification-actions',
  '/api/debug-traces/client-events',
  'unknown',
] as const
export type ClientTraceRoute = (typeof CLIENT_TRACE_ROUTES)[number]

const STATIC_ROUTE_TEMPLATES = new Set<string>(CLIENT_TRACE_ROUTES)
const ROUTE_TEMPLATES: ReadonlyArray<readonly [RegExp, ClientTraceRoute]> = [
  [
    /^\/api\/subscription\/billing\/account\/payment-method$/,
    '/api/subscription/billing/account/payment-method',
  ],
  [
    /^\/api\/subscription\/billing\/account\/invoices$/,
    '/api/subscription/billing/account/invoices',
  ],
  [
    /^\/api\/subscription\/billing\/account\/documents\/[^/]+$/,
    '/api/subscription/billing/account/documents/{id}',
  ],
  [/^\/[^/]+\/?$/, '/[locale]'],
  [/^\/[^/]+\/auth\/signin$/, '/[locale]/auth/signin'],
  [
    /^\/api\/campaigns\/agentic\/v1\/budget-redistributions\/targets$/,
    '/api/campaigns/agentic/v1/budget-redistributions/targets',
  ],
  [
    /^\/api\/campaigns\/agentic\/v1\/budget-redistributions\/preview$/,
    '/api/campaigns/agentic/v1/budget-redistributions/preview',
  ],
  [
    /^\/api\/campaigns\/agentic\/v1\/budget-redistributions\/by-command\/[^/]+$/,
    '/api/campaigns/agentic/v1/budget-redistributions/by-command/{id}',
  ],
  [
    /^\/api\/campaigns\/agentic\/v1\/budget-redistributions\/[^/]+(?:\/[^/]+)?$/,
    '/api/campaigns/agentic/v1/budget-redistributions',
  ],
  [
    /^\/api\/campaigns\/agentic\/v1\/budget-adjustments\/preview$/,
    '/api/campaigns/agentic/v1/budget-adjustments/preview',
  ],
  [
    /^\/api\/campaigns\/agentic\/v1\/budget-adjustments(?:\/[^/]+(?:\/[^/]+)?)?$/,
    '/api/campaigns/agentic/v1/budget-adjustments',
  ],
  [
    /^\/api\/notifications\/[^/]+\/read-all$/,
    '/api/notifications/{userId}/read-all',
  ],
  [
    /^\/api\/notifications\/[^/]+\/[^/]+\/read$/,
    '/api/notifications/{userId}/{id}/read',
  ],
  [/^\/api\/notifications\/[^/]+\/[^/]+$/, '/api/notifications/{userId}/{id}'],
  [
    /^\/api\/agent-chat\/conversations\/[^/]+$/,
    '/api/agent-chat/conversations/{id}',
  ],
  [
    /^\/api\/agent-chat\/conversations\/[^/]+\/turns$/,
    '/api/agent-chat/conversations/{id}/turns',
  ],
  [
    /^\/api\/agent-chat\/conversations\/[^/]+\/interactions$/,
    '/api/agent-chat/conversations/{id}/interactions',
  ],
  [
    /^\/api\/agent-chat\/conversations\/[^/]+\/answers$/,
    '/api/agent-chat/conversations/{id}/answers',
  ],
  [
    /^\/api\/agent-chat\/conversations\/[^/]+\/cancel$/,
    '/api/agent-chat/conversations/{id}/cancel',
  ],
  [
    /^\/api\/agent-chat\/conversations\/[^/]+\/publication-references$/,
    '/api/agent-chat/conversations/{id}/publication-references',
  ],
  [/^\/api\/library\/pieces\/[^/]+$/, '/api/library/pieces/{id}'],
  [
    /^\/api\/library\/pieces\/[^/]+\/download$/,
    '/api/library/pieces/{id}/download',
  ],
  [/^\/api\/library\/pieces\/[^/]+\/share$/, '/api/library/pieces/{id}/share'],
  [
    /^\/api\/integration\/meta\/oauth\/attempts\/[^/]+\/confirm$/,
    '/api/integration/meta/oauth/attempts/{id}/confirm',
  ],
  [
    /^\/api\/integration\/meta\/oauth\/attempts\/[^/]+\/status$/,
    '/api/integration/meta/oauth/attempts/{id}/status',
  ],
  [
    /^\/api\/agent-chat\/ai-connections\/(?:openai|xai)\/oauth\/start$/,
    '/api/agent-chat/ai-connections/{provider}/oauth/start',
  ],
  [
    /^\/api\/agent-chat\/ai-connections\/(?:openai|xai)\/oauth\/attempt$/,
    '/api/agent-chat/ai-connections/{provider}/oauth/attempt',
  ],
  [
    /^\/api\/sales-assistant\/businesses\/[^/]+\/agent-budget$/,
    '/api/sales-assistant/businesses/{id}/agent-budget',
  ],
  [
    /^\/[^/]+\/dashboard\/strategies\/draft\/[^/]+$/,
    '/[locale]/dashboard/strategies/draft/{id}',
  ],
  [
    /^\/[^/]+\/dashboard\/connected-accounts\/?$/,
    '/[locale]/dashboard/connected-accounts',
  ],
  [/^\/[^/]+\/dashboard\/library\/?$/, '/[locale]/dashboard/library'],
  [
    /^\/[^/]+\/dashboard\/debug\/traces\/?$/,
    '/[locale]/dashboard/debug/traces',
  ],
  [
    /^\/[^/]+\/actions\/notification-actions\/?$/,
    '/[locale]/actions/notification-actions',
  ],
]

/** Maps only known first-party routes to literal templates; no query or slug survives. */
export function clientTraceRouteTemplate(
  value: unknown,
  origin?: string
): ClientTraceRoute {
  if (typeof value !== 'string' || value.length > 2048) return 'unknown'
  const text = value.trim()
  if (STATIC_ROUTE_TEMPLATES.has(text)) return text as ClientTraceRoute
  if (/^https?:\/\//i.test(text) && !origin) return 'unknown'
  try {
    const base =
      origin && /^https?:\/\//i.test(origin) ? origin : 'http://localhost'
    const parsed = new URL(text, base)
    if (origin && parsed.origin !== new URL(origin).origin) return 'unknown'
    const pathname = parsed.pathname.replace(/\/$/, '') || '/'
    return (
      ROUTE_TEMPLATES.find(([pattern]) => pattern.test(pathname))?.[1] ??
      'unknown'
    )
  } catch {
    return 'unknown'
  }
}

export type ClientTraceMetadata = Readonly<{
  state?: ClientTraceState
  reason?: ClientTraceReason
  component?: ClientTraceComponent
  errorCode?: ClientTraceErrorCode
  route?: ClientTraceRoute
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD'
  statusCode?: number
  durationMs?: number
  count?: number
  byteCount?: number
  droppedCount?: number
  attempt?: number
  causality?: ClientTraceCausality
  transport?: ClientTraceTransport
  destination?: ClientTraceDestination
  clientBuildId?: string
  serverBuildId?: string
  resourceType?: ClientTraceResourceType
}>

const SAFE_METADATA_KEYS = new Set<keyof ClientTraceMetadata>([
  'state',
  'reason',
  'component',
  'errorCode',
  'route',
  'method',
  'statusCode',
  'durationMs',
  'count',
  'byteCount',
  'droppedCount',
  'attempt',
  'causality',
  'transport',
  'destination',
  'clientBuildId',
  'serverBuildId',
  'resourceType',
])

const SAFE_METADATA_ENUMS = {
  state: CLIENT_TRACE_STATES,
  reason: CLIENT_TRACE_REASONS,
  component: CLIENT_TRACE_COMPONENTS,
  errorCode: CLIENT_TRACE_ERROR_CODES,
  route: CLIENT_TRACE_ROUTES,
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  causality: CLIENT_TRACE_CAUSALITIES,
  transport: CLIENT_TRACE_TRANSPORTS,
  destination: CLIENT_TRACE_DESTINATIONS,
  resourceType: CLIENT_TRACE_RESOURCE_TYPES,
} as const

/** Copies only fixed own data properties; never invokes getters or serializes arbitrary values. */
export function projectClientTraceMetadata(
  value: unknown
): ClientTraceMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const projected: Record<string, string | number> = {}
  for (const key of SAFE_METADATA_KEYS) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      continue
    }
    if (!descriptor || !('value' in descriptor)) continue
    const candidate: unknown = descriptor.value
    if (key in SAFE_METADATA_ENUMS) {
      const allowed: readonly string[] =
        SAFE_METADATA_ENUMS[key as keyof typeof SAFE_METADATA_ENUMS]
      if (typeof candidate === 'string' && allowed.includes(candidate))
        projected[key] = candidate
      continue
    }
    if (key === 'clientBuildId' || key === 'serverBuildId') {
      if (
        typeof candidate === 'string' &&
        /^[A-Za-z0-9._-]{1,128}$/.test(candidate)
      )
        projected[key] = candidate
      else if (candidate === 'unknown') projected[key] = candidate
      continue
    }
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue
    if (
      key === 'statusCode' &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    )
      projected[key] = candidate
    else if (
      key !== 'statusCode' &&
      candidate >= 0 &&
      candidate <= 1_000_000 &&
      Number.isInteger(candidate)
    )
      projected[key] = candidate
  }
  return Object.keys(projected).length
    ? (projected as ClientTraceMetadata)
    : undefined
}

/** This object contains random tracing identity only, never a business/actor ID. */
export interface ClientTraceContextV1 {
  readonly schemaVersion: 1
  readonly contextId: string
  readonly scopeGeneration: number
  readonly operation: ClientTraceOperation
  readonly component?: ClientTraceComponent
  readonly correlationId: string
  readonly requestId: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly attempt: number
  readonly startedAt: number
}

export interface ClientTraceStartInput {
  operation: ClientTraceOperation
  component?: ClientTraceComponent
  parent?: ClientTraceContextV1
  metadata?: ClientTraceMetadata
}

export interface ClientTraceEventInput {
  phase: ClientTracePhase
  result: ClientTraceResult
  state?: ClientTraceState
  metadata?: ClientTraceMetadata
}

export interface ClientTraceHandle {
  readonly context: ClientTraceContextV1
  emit(event: ClientTraceEventInput): void
  end(event: ClientTraceEventInput): void
}

/** Bound operations retain their trace through awaits without ambient global state. */
export interface ClientTraceBinding {
  readonly context: ClientTraceContextV1
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  headers(input: RequestInfo | URL, init?: HeadersInit): Headers
}

export type ClientTraceDelivery =
  | 'queued'
  | 'forwarded'
  | 'unconfirmed'
  | 'unavailable'
  | 'dropped'

export interface ClientTraceHealth {
  enabled: boolean
  delivery: ClientTraceDelivery | 'idle'
  queuedEvents: number
  bufferedEvents: number
  droppedEvents: number
  scopeGeneration: number
}

export interface LocalClientTraceRecordV1 {
  event: {
    eventId: string
    correlationId: string
    requestId: string
    occurredAt: string
    phase: string
    result: ClientTraceResult
    attempt: number
    traceId?: string
    spanId?: string
    parentSpanId?: string
    durationMs?: number
    method?: string
    route?: string
    statusCode?: number
    observability?: Readonly<{
      schemaVersion: 1
      contextId: string
      operation: ClientTraceOperation
      component?: ClientTraceComponent
      state?: ClientTraceState
      metadata?: ClientTraceMetadata
    }>
    errorCode?: ClientTraceErrorCode
  }
  delivery: ClientTraceDelivery
}

export interface LocalClientTraceExportV1 {
  schemaVersion: 1
  exportedAt: string
  health: ClientTraceHealth
  events: LocalClientTraceRecordV1[]
}
