import { isIanaTimezone, type SalesAssistantMe } from '../types'

/**
 * Zona horaria del navegador (OCF-008) para que los recordatorios del
 * asistente corran en la hora del dueño. `undefined` si el navegador no da
 * una zona IANA válida: en ese caso no se manda nada y el servicio usa la suya.
 */
export function browserTimezone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && isIanaTimezone(zone) ? zone : undefined
  } catch {
    return undefined
  }
}

/**
 * ¿Hay que llevar la zona del navegador al asistente? Solo con un asistente
 * que existe y un back que ya informa su zona (`timezone` presente, aunque
 * sea `null`). Un back viejo no la manda: entonces no se hace nada.
 */
export function shouldSyncTimezone(
  me: SalesAssistantMe | undefined,
  browser: string | undefined
): boolean {
  if (!me || !browser || me.timezone === undefined) return false
  if (me.status === 'none' || me.status === 'deleting') return false
  return me.timezone !== browser
}

const claimed = new Set<string>()

function storageKey(userId: string, namespace: string): string {
  return `${namespace}:timezone-sync:${userId}`
}

/**
 * Un solo `PUT /timezone` por usuario y sesión de navegador, salga bien o
 * mal. La marca vive en sessionStorage, con copia en memoria si no hay.
 */
export function claimTimezoneSync(
  userId: string,
  namespace = 'sales-assistant'
): boolean {
  let seen: boolean
  try {
    seen = window.sessionStorage.getItem(storageKey(userId, namespace)) !== null
  } catch {
    seen = claimed.has(storageKey(userId, namespace))
  }
  if (seen) return false
  claimed.add(storageKey(userId, namespace))
  try {
    window.sessionStorage.setItem(
      storageKey(userId, namespace),
      String(Date.now())
    )
  } catch {
    // sin sessionStorage queda la copia en memoria
  }
  return true
}
