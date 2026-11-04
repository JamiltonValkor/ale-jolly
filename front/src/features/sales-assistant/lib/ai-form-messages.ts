import { SalesAssistantClientError } from '../sdk/sales-assistant-client'
import type { SalesAssistantAiResult, SalesAssistantProvider } from '../types'

export type SalesAssistantAiResultKey =
  | 'ai.results.ok'
  | 'ai.results.invalidKey'
  | 'ai.results.incompatibleModel'
  | 'ai.results.providerRejected'
  | 'ai.results.unreachable'

export type SalesAssistantAiFailureKey =
  | 'errors.sessionExpired'
  | 'ai.results.unreachable'

const RESULT_KEYS: Record<SalesAssistantAiResult, SalesAssistantAiResultKey> = {
  ok: 'ai.results.ok',
  invalid_key: 'ai.results.invalidKey',
  incompatible_model: 'ai.results.incompatibleModel',
  provider_rejected: 'ai.results.providerRejected',
  unreachable: 'ai.results.unreachable',
}

/** Clave i18n (namespace `salesAssistant`) para el `result` de `PUT /ai`. */
export function aiResultMessageKey(
  result: SalesAssistantAiResult
): SalesAssistantAiResultKey {
  return RESULT_KEYS[result]
}

/**
 * Clave i18n cuando el `PUT /ai` no llega a dar un `result` (red, servicio,
 * respuesta sin contrato). Los dueños no son técnicos: nunca se muestra el
 * código ni el detalle, solo si deben volver a iniciar sesión o reintentar.
 */
export function aiFailureMessageKey(
  error: unknown
): SalesAssistantAiFailureKey {
  if (
    error instanceof SalesAssistantClientError &&
    error.code === 'UNAUTHORIZED'
  )
    return 'errors.sessionExpired'
  return 'ai.results.unreachable'
}

/** Proveedor recomendado (el único probado de punta a punta en dev): va primero. */
export const PREFERRED_AI_PROVIDER = 'openrouter'

/**
 * Proveedores que el formulario ofrece: OpenRouter primero y el resto en el
 * orden del back (OCF-008). En v1 el `PUT /ai` exige `api_key`, así que solo
 * se ofrecen los que piden key.
 */
export function offeredAiProviders(
  providers: readonly SalesAssistantProvider[] | undefined
): SalesAssistantProvider[] {
  const offered = (providers ?? []).filter(provider => provider.needs_key)
  return [
    ...offered.filter(provider => provider.id === PREFERRED_AI_PROVIDER),
    ...offered.filter(provider => provider.id !== PREFERRED_AI_PROVIDER),
  ]
}
