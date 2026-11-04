import { SalesAssistantClientError } from '../sdk/sales-assistant-client'

export type ApprovalErrorKey =
  | 'approvals.errors.expired'
  | 'approvals.errors.stale'
  | 'approvals.errors.alreadyDecided'
  | 'approvals.errors.notFound'
  | 'approvals.errors.sessionExpired'
  | 'approvals.errors.codeInvalid'
  | 'approvals.errors.codeExpired'
  | 'approvals.errors.codeAttempts'
  | 'approvals.errors.generic'

/**
 * Clave i18n (namespace `salesAssistant`) de un error de la página de
 * aprobación (OSF-003). Un usuario ajeno recibe 404: se muestra «no disponible»,
 * sin decir si la aprobación existe. Cualquier 503 o fallo de red es genérico.
 */
export function approvalErrorKey(error: unknown): ApprovalErrorKey {
  if (!(error instanceof SalesAssistantClientError))
    return 'approvals.errors.generic'
  switch (error.code) {
    case 'APPROVAL_EXPIRED':
      return 'approvals.errors.expired'
    case 'APPROVAL_STALE':
      return 'approvals.errors.stale'
    case 'APPROVAL_ALREADY_DECIDED':
      return 'approvals.errors.alreadyDecided'
    case 'NOT_FOUND':
    case 'ASSISTANT_NOT_ENABLED':
      return 'approvals.errors.notFound'
    case 'UNAUTHORIZED':
      return 'approvals.errors.sessionExpired'
    // MLB-013: código de un solo uso de las aprobaciones de gasto.
    case 'APPROVAL_CODE_INVALID':
      return 'approvals.errors.codeInvalid'
    case 'APPROVAL_CODE_EXPIRED':
      return 'approvals.errors.codeExpired'
    case 'APPROVAL_CODE_ATTEMPTS':
      return 'approvals.errors.codeAttempts'
    default:
      return 'approvals.errors.generic'
  }
}
