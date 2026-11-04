'use client'

/**
 * Stub del modo local: sin PostHog en el cliente, toda bandera que consulte
 * Meta Assistant está encendida (el servicio sigue validando la suya).
 */
export function useFeatureFlag(_flag: string): boolean {
  return true
}

export function useFeatureFlagVariant(_flag: string): string | undefined {
  return undefined
}
