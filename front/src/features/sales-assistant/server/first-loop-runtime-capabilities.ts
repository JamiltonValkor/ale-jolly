import 'server-only'

/** Explicit local pilot for the pinned first-loop210 runtime. No error-driven fallback. */
export function legacyFirstLoopPilotEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.META_ASSISTANT_LEGACY_FIRST_LOOP_ENABLED === 'true'
  )
}

/** Frozen capability of210c0d1, not a new global product locale list. */
export function legacyFirstLoopLocaleSupported(locale: string): boolean {
  return locale === 'es' || locale === 'en'
}
