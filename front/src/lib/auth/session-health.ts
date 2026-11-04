export interface UsableSession {
  user: {
    id: string
    [key: string]: unknown
  }
  accessToken: string
  error?: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Minimum session contract shared by public and protected auth consumers.
 *
 * Auth.js owns expiry and refresh. Consumers only accept the session returned
 * after that lifecycle has resolved when it still has a user, bearer and no
 * error.
 */
export function isUsableSession(value: unknown): value is UsableSession {
  if (!isRecord(value) || !isRecord(value.user)) return false

  return (
    typeof value.user.id === 'string' &&
    value.user.id.trim().length > 0 &&
    typeof value.accessToken === 'string' &&
    value.accessToken.trim().length > 0 &&
    value.error == null
  )
}
