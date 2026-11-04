interface Attempt {
  digest: string
  id: string
  key: string
}
const memory = new Map<string, Attempt>()
const UUID = /^[a-f0-9-]{36}$/
const storageKey = (scope: string) =>
  `meta-assistant:first-loop:attempt:${scope}`

/** Retire only the acknowledged attempt; a late ACK must not clear a newer send. */
export function completeFirstLoopAttempt(scope: string, id: string): void {
  const key = storageKey(scope)
  if (memory.get(key)?.id === id) memory.delete(key)
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (value && typeof value === 'object' && 'id' in value && value.id === id)
      sessionStorage.removeItem(key)
  } catch {
    /* The in-memory receipt is enough when storage is unavailable. */
  }
}

/** Only a SHA256 and opaque attempt IDs survive reload; never persist owner text. */
export async function firstLoopAttempt(
  scope: string,
  payload: unknown
): Promise<Attempt> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const digest = Array.from(new Uint8Array(hash), value =>
    value.toString(16).padStart(2, '0')
  ).join('')
  const key = storageKey(scope)
  let saved = memory.get(key)
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (
      raw &&
      typeof raw === 'object' &&
      'digest' in raw &&
      'id' in raw &&
      'key' in raw &&
      typeof raw.digest === 'string' &&
      typeof raw.id === 'string' &&
      typeof raw.key === 'string' &&
      UUID.test(raw.id) &&
      UUID.test(raw.key)
    )
      saved = { digest: raw.digest, id: raw.id, key: raw.key }
  } catch {
    /* Storage can be unavailable; this tab retains the same attempt. */
  }
  if (saved?.digest === digest) return saved
  const attempt = { digest, id: crypto.randomUUID(), key: crypto.randomUUID() }
  memory.set(key, attempt)
  try {
    sessionStorage.setItem(key, JSON.stringify(attempt))
  } catch {
    /* Memory fallback. */
  }
  return attempt
}
