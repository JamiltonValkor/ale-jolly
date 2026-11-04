import { SalesAssistantClientError } from '../sdk/sales-assistant-client'

export type SalesAssistantErrorKey =
  | 'errors.notAvailable'
  | 'errors.sessionExpired'
  | 'errors.generic'

/**
 * Clave i18n (namespace `salesAssistant`) para un error del SDK. Los dueños no
 * son técnicos: nunca se muestra el código ni el detalle, solo un texto simple.
 */
export function salesAssistantErrorKey(error: unknown): SalesAssistantErrorKey {
  if (!(error instanceof SalesAssistantClientError)) return 'errors.generic'
  if (error.code === 'ASSISTANT_NOT_ENABLED') return 'errors.notAvailable'
  if (error.code === 'UNAUTHORIZED') return 'errors.sessionExpired'
  return 'errors.generic'
}
