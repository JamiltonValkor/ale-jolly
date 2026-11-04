export const AUTH_SESSION_INVALIDATION_EVENT = 'auth:session-invalidated'
export const AUTH_SESSION_INVALIDATION_STORAGE_KEY =
  'saleads:auth-session-invalidated'

let invalidationRevision = 0

function nextInvalidationRevision(): string {
  invalidationRevision += 1
  return `${Date.now()}:${invalidationRevision}`
}

/**
 * Notify the current document and other same-origin tabs that the local Auth.js
 * session is being destroyed. The marker contains no identity or token data.
 */
export function publishSessionInvalidation(): void {
  if (typeof window === 'undefined') return

  window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATION_EVENT))

  try {
    window.localStorage.setItem(
      AUTH_SESSION_INVALIDATION_STORAGE_KEY,
      nextInvalidationRevision()
    )
  } catch {
    // Storage can be unavailable in privacy modes; the current-tab event still ran.
  }
}

/** Subscribe to both current-document and cross-tab invalidation signals. */
export function subscribeToSessionInvalidation(
  listener: () => void
): () => void {
  if (typeof window === 'undefined') return () => {}

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === AUTH_SESSION_INVALIDATION_STORAGE_KEY &&
      event.newValue !== null
    ) {
      listener()
    }
  }

  window.addEventListener(AUTH_SESSION_INVALIDATION_EVENT, listener)
  window.addEventListener('storage', handleStorage)

  return () => {
    window.removeEventListener(AUTH_SESSION_INVALIDATION_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}
