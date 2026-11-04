export type TraceEnvironment = 'local' | 'dev' | 'preprod'
export type TraceResult =
  | 'started'
  | 'success'
  | 'error'
  | 'partial'
  | 'retry'
  | 'dropped'

export type TraceSource =
  | 'frontend'
  | 'gateway'
  | 'service'
  | 'external'
  | 'outbox'
  | 'pubsub'
  | 'worker'
  | 'webhook'

export interface TraceEventV1 {
  schemaVersion: 1
  eventId: string
  correlationId: string
  requestId: string
  occurredAt: string
  environment: TraceEnvironment
  serviceName: string
  source: TraceSource
  provenance: 'client_untrusted' | 'server_trusted'
  phase: string
  result: TraceResult
  attempt: number
  traceId?: string
  spanId?: string
  parentSpanId?: string
  causationId?: string
  userId?: string
  businessId?: string
  durationMs?: number
  method?: string
  route?: string
  statusCode?: number
  safeRequest?: unknown
  safeResponse?: unknown
  observability?: unknown
  errorCode?: string
  sentryRef?: string
  posthogRef?: string
}

export interface StoredTraceEvent extends TraceEventV1 {
  sequence: string
  ingestedAt: string
}

export interface TraceChainSummary {
  correlationId: string
  firstOccurredAt: string
  lastOccurredAt: string
  lastSequence: string
  eventCount: number
  errorCount: number
  retryCount: number
  maxDurationMs: number
  services: string[]
  lastResult: string
  lastPhase: string
}

export interface TraceSearchResponse {
  chains: TraceChainSummary[]
  nextCursor?: string
}

export interface TraceTimeline {
  correlationId: string
  status: 'completed' | 'partial' | 'expired'
  durationMs: number
  retries: number
  services: string[]
  missingSteps: string[]
  events: StoredTraceEvent[]
}

export interface ClientTraceInput {
  eventId?: string
  correlationId: string
  requestId: string
  occurredAt?: string
  phase: string
  result: TraceResult
  attempt?: number
  traceId?: string
  spanId?: string
  parentSpanId?: string
  durationMs?: number
  method?: string
  route?: string
  statusCode?: number
  safeRequest?: unknown
  safeResponse?: unknown
  observability?: unknown
  errorCode?: string
  sentryRef?: string
  posthogRef?: string
}
