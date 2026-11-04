import 'server-only'
import { randomUUID } from 'node:crypto'
import {
  getServerTraceCaptureConfig,
  type ServerTraceEnvironment,
} from './server-trace-config'
import {
  authorizeTraceAccess,
  collectorFetch,
  isAccessResponse,
} from '@/features/debug-traces/server/collector'
import { getServerBuildIdentity } from './server-build-identity'
import {
  CLIENT_TRACE_COMPONENTS,
  CLIENT_TRACE_DESTINATIONS,
  CLIENT_TRACE_ERROR_CODES,
  CLIENT_TRACE_OPERATIONS,
  CLIENT_TRACE_PHASES,
  CLIENT_TRACE_REASONS,
  CLIENT_TRACE_STATES,
  CLIENT_TRACE_TRANSPORTS,
  clientTraceRouteTemplate,
  projectClientTraceMetadata,
  type ClientTraceComponent,
  type ClientTraceDestination,
  type ClientTraceErrorCode,
  type ClientTraceMetadata,
  type ClientTraceOperation,
  type ClientTracePhase,
  type ClientTraceReason,
  type ClientTraceState,
  type ClientTraceTransport,
} from '@/shared/observability/debug-trace-contract'

type TraceResult =
  | 'started'
  | 'success'
  | 'error'
  | 'partial'
  | 'retry'
  | 'dropped'
type TraceEnvironment = ServerTraceEnvironment

export interface ServerTraceContext {
  correlationId: string
  requestId: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  attempt: number
}

export interface ServerTraceEventInput extends ServerTraceContext {
  source?: 'gateway' | 'service'
  operation: ClientTraceOperation
  component: ClientTraceComponent
  phase: ClientTracePhase
  result: TraceResult
  state: ClientTraceState
  reason?: ClientTraceReason
  errorCode?: ClientTraceErrorCode
  method?: string
  route?: string
  statusCode?: number
  durationMs?: number
  count?: number
  transport?: ClientTraceTransport
  destination?: ClientTraceDestination
  metadata?: ClientTraceMetadata
}

export type ServerGatewayTraceInput = Omit<
  ServerTraceEventInput,
  'operation' | 'component' | 'transport' | 'destination'
> & {
  method: string
  route: string
}

function captureConfig() {
  return getServerTraceCaptureConfig()
}

function allowed<T extends string>(
  value: unknown,
  values: readonly T[]
): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function uuidOrNew(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
    ? value.toLowerCase()
    : randomUUID()
}

function eventFor(input: ServerTraceEventInput, environment: TraceEnvironment) {
  if (
    !allowed(input.operation, CLIENT_TRACE_OPERATIONS) ||
    !allowed(input.component, CLIENT_TRACE_COMPONENTS) ||
    !allowed(input.phase, CLIENT_TRACE_PHASES) ||
    !allowed(input.result, [
      'started',
      'success',
      'error',
      'partial',
      'retry',
      'dropped',
    ] as const) ||
    !allowed(input.state, CLIENT_TRACE_STATES)
  )
    return undefined

  const method = input.method?.toUpperCase()
  if (
    method &&
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(
      method
    )
  )
    return undefined
  const route = input.route ? clientTraceRouteTemplate(input.route) : undefined
  const metadataInput = projectClientTraceMetadata(input.metadata) ?? {}
  const metadata: ClientTraceMetadata = {
    ...metadataInput,
    ...(method ? { method: method as ClientTraceMetadata['method'] } : {}),
    ...(route && route !== 'unknown' ? { route } : {}),
    ...(Number.isSafeInteger(input.statusCode) &&
    input.statusCode! >= 100 &&
    input.statusCode! <= 599
      ? { statusCode: input.statusCode }
      : {}),
    ...(Number.isSafeInteger(input.durationMs) && input.durationMs! >= 0
      ? { durationMs: Math.min(1_000_000, input.durationMs!) }
      : {}),
    ...(Number.isSafeInteger(input.count) && input.count! >= 0
      ? { count: Math.min(1_000_000, input.count!) }
      : {}),
    attempt: Number.isSafeInteger(input.attempt)
      ? Math.max(1, Math.min(32767, input.attempt))
      : 1,
    causality: 'explicit',
    transport: allowed(input.transport, CLIENT_TRACE_TRANSPORTS)
      ? input.transport
      : 'fetch',
    destination: allowed(input.destination, CLIENT_TRACE_DESTINATIONS)
      ? input.destination
      : 'first_party',
    serverBuildId: getServerBuildIdentity().id,
    ...(allowed(input.reason, CLIENT_TRACE_REASONS)
      ? { reason: input.reason }
      : {}),
  }
  const projectedMetadata = projectClientTraceMetadata(metadata)
  const errorCode = allowed(input.errorCode, CLIENT_TRACE_ERROR_CODES)
    ? input.errorCode
    : undefined
  const traceId =
    input.traceId &&
    /^[a-f0-9]{32}$/i.test(input.traceId) &&
    !/^0+$/.test(input.traceId)
      ? input.traceId.toLowerCase()
      : undefined
  const spanId =
    input.spanId &&
    /^[a-f0-9]{16}$/i.test(input.spanId) &&
    !/^0+$/.test(input.spanId)
      ? input.spanId.toLowerCase()
      : undefined
  const parentSpanId =
    input.parentSpanId &&
    /^[a-f0-9]{16}$/i.test(input.parentSpanId) &&
    !/^0+$/.test(input.parentSpanId)
      ? input.parentSpanId.toLowerCase()
      : undefined
  const durationMs = metadata.durationMs
  const attempt = metadata.attempt
  const statusCode = metadata.statusCode
  const event = {
    schemaVersion: 1,
    eventId: randomUUID(),
    correlationId: uuidOrNew(input.correlationId),
    requestId: uuidOrNew(input.requestId),
    occurredAt: new Date().toISOString(),
    environment,
    serviceName: 'saleads-frontend',
    source: input.source ?? 'gateway',
    provenance: 'server_trusted',
    phase: input.phase,
    result: input.result,
    attempt,
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(method ? { method } : {}),
    ...(route && route !== 'unknown' ? { route } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(errorCode ? { errorCode } : {}),
    observability: {
      schemaVersion: 1,
      contextId: randomUUID(),
      operation: input.operation,
      component: input.component,
      state: input.state,
      ...(projectedMetadata ? { metadata: projectedMetadata } : {}),
    },
  }
  return event
}

/** Emits a closed event asynchronously; telemetry never blocks product work. */
export function emitServerTraceEvent(input: ServerTraceEventInput): void {
  try {
    const config = captureConfig()
    if (!config) return
    const event = eventFor(input, config.environment)
    if (!event) return
    const body = JSON.stringify({ events: [event] })
    if (new TextEncoder().encode(body).byteLength > 8 * 1024) return
    void forwardServerTrace(body).catch(() => {})
  } catch {
    // Telemetry serialization and transport must never alter a product response.
  }
}

async function forwardServerTrace(body: string): Promise<void> {
  const access = await authorizeTraceAccess({ requireDebugRole: false })
  if (isAccessResponse(access)) return
  await collectorFetch(access, '/api/internal/trace-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(1_000),
  })
}

/** Gateway events never include bodies, query values, IDs from routes, or errors. */
export function emitServerGatewayTrace(input: ServerGatewayTraceInput): void {
  const route = clientTraceRouteTemplate(input.route)
  emitServerTraceEvent({
    ...input,
    operation: 'http_request',
    component: route.startsWith('/api/agent-chat/') ? 'agent_chat' : 'unknown',
    transport: 'fetch',
    destination: 'first_party',
  })
}
