import { SalesAssistantClientError } from '../sdk/sales-assistant-client'

export type StockErrorKey =
  | 'errors.gone'
  | 'errors.stockNegative'
  | 'errors.sessionExpired'
  | 'errors.decision'
  | 'errors.invalid'
  | 'errors.invalidKit'
  | 'errors.levelChanged'
  | 'errors.levelInvalid'
  | 'errors.cancelGone'
  | 'errors.cancel'

const hasCode = (error: unknown, ...codes: string[]) =>
  error instanceof SalesAssistantClientError && codes.includes(error.code)

/** Vencida, resuelta o ajena: no hay nada que reintentar, se relee la lista. */
export function isStockGoneError(error: unknown): boolean {
  return hasCode(error, 'CONFLICT', 'NOT_FOUND')
}

/** Saldo insuficiente: reintentar daría lo mismo, primero hay que contar. */
export function isStockNegativeError(error: unknown): boolean {
  return hasCode(error, 'STOCK_NEGATIVE')
}

/** Rechazado por sus datos, como un kit con monedas distintas: no mejora reintentando. */
export function isStockInvalidError(error: unknown): boolean {
  return hasCode(error, 'INVALID_REQUEST')
}

/** Reintentar igual daría lo mismo: el diálogo no lo ofrece. */
export function isStockFinalError(error: unknown): boolean {
  return (
    isStockGoneError(error) ||
    isStockNegativeError(error) ||
    isStockInvalidError(error)
  )
}

/**
 * Clave i18n (`metaExperience.stock`) de un error al decidir. Sin códigos: los dueños
 * no son técnicos. El genérico no afirma que nada cambió, porque un 503 por
 * tiempo puede ocurrir con la escritura hecha.
 */
export function stockErrorKey(error: unknown, tipo?: string): StockErrorKey {
  if (isStockGoneError(error)) return 'errors.gone'
  if (isStockNegativeError(error)) return 'errors.stockNegative'
  if (isStockInvalidError(error))
    return tipo === 'kit' ? 'errors.invalidKit' : 'errors.invalid'
  if (hasCode(error, 'UNAUTHORIZED')) return 'errors.sessionExpired'
  return 'errors.decision'
}

/** Al cambiar de nivel, un conflicto significa que el área cambió, no una propuesta. */
export function stockLevelErrorKey(error: unknown): StockErrorKey {
  if (isStockGoneError(error)) return 'errors.levelChanged'
  if (isStockInvalidError(error)) return 'errors.levelInvalid'
  return stockErrorKey(error)
}

/** `CONFLICT`: el pedido ya quedó acordado o recibido, y por eso no se cancela. */
export function stockCancelErrorKey(error: unknown): StockErrorKey {
  if (isStockGoneError(error)) return 'errors.cancelGone'
  if (hasCode(error, 'UNAUTHORIZED')) return 'errors.sessionExpired'
  return 'errors.cancel'
}
