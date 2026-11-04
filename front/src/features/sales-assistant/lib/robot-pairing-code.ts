import { SalesAssistantClientError } from '../sdk/sales-assistant-client'

/**
 * Código de emparejamiento del robot (D3): 8 caracteres que la cara muestra
 * como `XXXX-XXXX`. El dueño puede escribirlo en minúsculas, con espacios o
 * sin guion; aquí se lleva a la forma canónica mientras escribe.
 */
export const ROBOT_CODE_LENGTH = 8
const COMPLETE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/

export function formatRobotPairingCode(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROBOT_CODE_LENGTH)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

export function isCompleteRobotPairingCode(value: string): boolean {
  return COMPLETE.test(value)
}

/** `?code=` del QR del robot: solo un código completo abre el modal. */
export function robotPairingCodeFromQuery(value: string | null): string | null {
  if (!value) return null
  const code = formatRobotPairingCode(value)
  return isCompleteRobotPairingCode(code) ? code : null
}

export type RobotClaimErrorKey =
  | 'invalidCode'
  | 'tooManyAttempts'
  | 'sessionExpired'
  | 'generic'

/** Clave i18n (`metaAssistant.robotCompanion.errors.*`) de un reclamo fallido. */
export function robotClaimErrorKey(error: unknown): RobotClaimErrorKey {
  if (!(error instanceof SalesAssistantClientError)) return 'generic'
  switch (error.code) {
    case 'NOT_FOUND':
    case 'INVALID_REQUEST':
      return 'invalidCode'
    case 'PAIRING_ATTEMPTS':
      return 'tooManyAttempts'
    case 'UNAUTHORIZED':
      return 'sessionExpired'
    default:
      return 'generic'
  }
}

/** Con `ROBOT_CHANNEL_ENABLED` apagado las rutas no existen (404). */
export function isRobotChannelUnavailable(error: unknown): boolean {
  return (
    error instanceof SalesAssistantClientError &&
    (error.code === 'NOT_FOUND' || error.status === 404)
  )
}
