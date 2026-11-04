const MAX_RETRY_AFTER_SECONDS = 3600

/**
 * Convert the HTTP Retry-After header into a bounded number of seconds.
 * Supports both forms permitted by RFC 9110: delay-seconds and HTTP-date.
 */
export function parseRetryAfterSeconds(
  retryAfter: string | null,
  now = Date.now()
): number | undefined {
  if (!retryAfter) return undefined

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) {
    return seconds > 0
      ? Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS)
      : undefined
  }

  const retryAt = Date.parse(retryAfter)
  if (Number.isNaN(retryAt)) return undefined

  return Math.min(
    Math.max(1, Math.ceil((retryAt - now) / 1000)),
    MAX_RETRY_AFTER_SECONDS
  )
}
