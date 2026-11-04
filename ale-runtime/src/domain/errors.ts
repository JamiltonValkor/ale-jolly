import type {ErrorCodeV1} from '../contracts/v1';

/**
 * Error público del servicio. Solo lleva un código fijo y el status HTTP:
 * nunca adjunta la entrada, la respuesta de una dependencia ni un `cause`
 * (invariante 4: sin tokens ni contenido privado en respuestas o logs).
 */
export class ServiceError extends Error {
  constructor(readonly code: ErrorCodeV1, readonly status: number) {
    super(code);
    this.name = 'ServiceError';
  }
}

export const invalidRequest = () => new ServiceError('INVALID_REQUEST', 400);
export const unauthorized =() => new ServiceError('UNAUTHORIZED', 401);
export const assistantNotEnabled = () => new ServiceError('ASSISTANT_NOT_ENABLED', 403);
export const flagUnavailable = () => new ServiceError('FLAG_UNAVAILABLE', 503);
export const serviceUnavailable = () => new ServiceError('SERVICE_UNAVAILABLE', 503);
/** El chat solo existe con el asistente en `ready` (OCB-011). */
export const assistantNotReady = () => new ServiceError('ASSISTANT_NOT_READY', 409);
export const notFound = () => new ServiceError('NOT_FOUND', 404);
/** Hermes no responde y la VM sigue encendida: se está reiniciando (OCB-016). */
export const assistantRestarting = () => new ServiceError('ASSISTANT_RESTARTING', 503);
/** ORQA cliente (OSB-013): la aprobación venció. */
export const approvalExpired = () => new ServiceError('APPROVAL_EXPIRED', 410);
/** ORQA cliente (OSB-013): el ítem cambió de versión entre la propuesta y la aprobación. */
export const approvalStale = () => new ServiceError('APPROVAL_STALE', 409);
/** ORQA cliente (OSB-013): ya se aprobó o rechazó con otra decisión. */
export const approvalAlreadyDecided = () => new ServiceError('APPROVAL_ALREADY_DECIDED', 409);
/** ORQA cliente (OSB-015): la API admin del buzón solo es para la lista blanca. */
export const forbidden = () => new ServiceError('FORBIDDEN', 403);
/** MLB-013: el código de un solo uso no coincide (o falta). */
export const approvalCodeInvalid = () => new ServiceError('APPROVAL_CODE_INVALID', 422);
/** MLB-013: el código venció (5 minutos): hay que pedir otro. */
export const approvalCodeExpired = () => new ServiceError('APPROVAL_CODE_EXPIRED', 422);
/** MLB-013: se agotaron los intentos del código o los códigos de la aprobación. */
export const approvalCodeAttempts = () => new ServiceError('APPROVAL_CODE_ATTEMPTS', 429);
/** AAB-012: el presupuesto mensual del agente cambió de revisión desde que el dueño lo leyó. */
export const budgetRevisionConflict = () => new ServiceError('BUDGET_REVISION_CONFLICT', 412);
/** AAB-012: `PUT …/agent-budget` exige `If-Match` (`*` si aún no hay presupuesto). */
export const preconditionRequired = () => new ServiceError('INVALID_REQUEST', 428);
/** Stock: propuesta resuelta o vencida, revisión vieja o misma clave con otra petición. */
export const conflict = () => new ServiceError('CONFLICT', 409);
/** Stock: el movimiento dejaría el saldo negativo; no se inserta nada ni se recorta a cero. */
export const stockNegative = () => new ServiceError('STOCK_NEGATIVE', 409);
/** IVB-012: un aviso es para voz. El motivo es el código, porque `ServiceError` no lleva detalle. */
export const stockTextTooLong = () => new ServiceError('STOCK_TEXT_TOO_LONG', 400);
/** IVB-024 (F-R2b): un producto o una propuesta de otra corrida, o real con una corrida activa. No es reintentable. */
export const stockOtherRun = () => new ServiceError('STOCK_OTHER_RUN', 400);
/** IVB-024: un aviso de Stock (`AVISO:` o clave `alerta`) solo se dice con su `alerta_id`, para que el servidor sepa qué ya se dijo. */
export const stockAlertIdRequired = () => new ServiceError('STOCK_ALERT_ID_REQUIRED', 400);
/** Canal robot: demasiados códigos de emparejamiento fallidos seguidos (por usuario). */
export const pairingAttempts = () => new ServiceError('PAIRING_ATTEMPTS', 429);
