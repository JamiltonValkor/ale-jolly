const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(value)
  return Array.from(value, item => item.toString(16).padStart(2, '0')).join('')
}

function logicalId(value: string | null): string {
  return sanitizeTraceIdentifier(value) ?? globalThis.crypto.randomUUID()
}

/** Keeps an observed identifier only; missing upstream references stay missing. */
export function sanitizeTraceIdentifier(
  value: string | null | undefined
): string | undefined {
  return value && value === value.trim() && SAFE_ID.test(value)
    ? value
    : undefined
}

function parseTraceparent(value: string | null): RegExpMatchArray | undefined {
  const incoming = value?.trim().match(TRACEPARENT)
  if (!incoming || /^0+$/.test(incoming[1]) || /^0+$/.test(incoming[2])) {
    return undefined
  }
  return incoming
}

function validAttempt(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 32_767
    ? value
    : undefined
}

function requestAttempt(incoming: string | null, override?: number): number {
  const parsed =
    incoming && /^[1-9]\d{0,4}$/.test(incoming) ? Number(incoming) : undefined
  return validAttempt(override) ?? validAttempt(parsed) ?? 1
}

export interface OutboundTraceContext {
  headers: Headers
  correlationId: string
  requestId: string
  traceId: string
  spanId: string
  parentSpanId?: string
  attempt: number
}

/** Builds canonical outbound headers while preserving a valid logical context. */
export function withTraceHeaders(
  source: HeadersInit | undefined,
  options?: { attempt?: number }
): OutboundTraceContext {
  const headers = new Headers(source)
  const correlationId = logicalId(headers.get('x-correlation-id'))
  const requestId = logicalId(headers.get('x-request-id'))
  const incoming = parseTraceparent(headers.get('traceparent'))
  const traceId = incoming?.[1].toLowerCase() ?? randomHex(16)
  const parentSpanId = incoming?.[2].toLowerCase()
  const flags = incoming?.[3].toLowerCase() ?? '01'
  const spanId = randomHex(8)
  const attempt = requestAttempt(
    headers.get('x-request-attempt'),
    options?.attempt
  )

  headers.set('x-correlation-id', correlationId)
  headers.set('x-request-id', requestId)
  headers.set('x-request-attempt', String(attempt))
  headers.set('traceparent', `00-${traceId}-${spanId}-${flags}`)
  return {
    headers,
    correlationId,
    requestId,
    traceId,
    spanId,
    parentSpanId,
    attempt,
  }
}
