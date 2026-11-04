const SENSITIVE =
  /token|secret|password|authorization|cookie|apikey|email|phone|address|prompt|content|description|name/i

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]'
  if (typeof value === 'string')
    return value
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/https?:\/\/[^\s"<>]+/gi, '[URL REDACTED]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL REDACTED]')
      .slice(0, 4000)
  if (Array.isArray(value))
    return value.slice(0, 50).map(item => redact(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE.test(key.replace(/[_-]/g, ''))
        ? '[REDACTED]'
        : redact(item, depth + 1),
    ])
  )
}

function containsFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, item]) =>
      (key === 'status' && item === 'failed') ||
      (key === 'failureCode' && Boolean(item)) ||
      (key === 'ok' && item === false) ||
      containsFailure(item)
  )
}

interface Diagnostic {
  endpoint: string
  method: string
  durationMs: number
  status?: number
  requestId?: string | null
  body?: unknown
  transportError?: string
}

/** Local terminal only; never forwards raw service bodies to telemetry. */
export function logStrategyResponse(input: Diagnostic): void {
  if (
    process.env.NODE_ENV !== 'development' ||
    !input.endpoint.startsWith('/api/strategy/v2/')
  )
    return
  if (
    !input.transportError &&
    !(input.status && input.status >= 400) &&
    !containsFailure(input.body)
  )
    return
  try {
    const body =
      typeof input.body === 'string'
        ? '[Non-JSON response omitted]'
        : redact(input.body)
    const serialized = JSON.stringify({
      ...input,
      endpoint: input.endpoint.split('?')[0],
      body,
    })
    console.warn('[strategy-response]', serialized.slice(0, 24000))
  } catch {
    // Diagnostics must never change request behavior.
  }
}
