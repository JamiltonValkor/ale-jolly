/**
 * `Idempotency-Key` de la activación, guardada en sessionStorage por usuario.
 * Recargar o volver a hacer clic reutiliza la misma clave, así el servicio no
 * crea otra activación. Se limpia cuando el estado deja de ser `none` y caduca
 * con el flujo de acceso (10 min), para que un intento abandonado no quede
 * atado a un enlace vencido.
 */
export const ACTIVATION_KEY_TTL_MS = 10 * 60_000

interface StoredKey {
  key: string
  createdAt: number
}

const memory = new Map<string, StoredKey>()

function storageKey(userId: string, namespace: string): string {
  return `${namespace}:activation:${userId}`
}

function parse(raw: string | null): StoredKey | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === 'object' &&
      'key' in value &&
      'createdAt' in value &&
      typeof value.key === 'string' &&
      typeof value.createdAt === 'number'
    )
      return { key: value.key, createdAt: value.createdAt }
  } catch {
    // valor ilegible: se genera uno nuevo
  }
  return null
}

function read(userId: string, namespace: string): StoredKey | null {
  try {
    return parse(window.sessionStorage.getItem(storageKey(userId, namespace)))
  } catch {
    return memory.get(storageKey(userId, namespace)) ?? null
  }
}

function write(userId: string, value: StoredKey, namespace: string): void {
  memory.set(storageKey(userId, namespace), value)
  try {
    window.sessionStorage.setItem(
      storageKey(userId, namespace),
      JSON.stringify(value)
    )
  } catch {
    // sin sessionStorage queda la copia en memoria
  }
}

export function getOrCreateActivationKey(
  userId: string,
  namespace = 'sales-assistant'
): string {
  const stored = read(userId, namespace)
  const now = Date.now()
  if (stored && now - stored.createdAt <= ACTIVATION_KEY_TTL_MS)
    return stored.key
  const fresh = { key: crypto.randomUUID(), createdAt: now }
  write(userId, fresh, namespace)
  return fresh.key
}

/**
 * ¿Hay una primera activación en curso? Solo existe la clave si el dueño pulsó
 * «Activar» hace menos de 10 min. No crea ninguna.
 */
export function hasActivationKey(
  userId: string,
  namespace = 'sales-assistant'
): boolean {
  const stored = read(userId, namespace)
  return !!stored && Date.now() - stored.createdAt <= ACTIVATION_KEY_TTL_MS
}

export function clearActivationKey(
  userId: string,
  namespace = 'sales-assistant'
): void {
  memory.delete(storageKey(userId, namespace))
  try {
    window.sessionStorage.removeItem(storageKey(userId, namespace))
  } catch {
    // nada que limpiar
  }
}

/**
 * Recuperación silenciosa del acceso (OCB-009): como mucho un intento por
 * usuario cada 10 min, aunque el panel se recargue. La marca (solo la hora del
 * último intento) vive en sessionStorage, con copia en memoria si no hay.
 */
export const ACCESS_RECOVERY_INTERVAL_MS = 10 * 60_000

const recoveryMemory = new Map<string, number>()

function recoveryStorageKey(userId: string, namespace: string): string {
  return `${namespace}:access-recovery:${userId}`
}

function readRecovery(userId: string, namespace: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(
      recoveryStorageKey(userId, namespace)
    )
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return recoveryMemory.get(recoveryStorageKey(userId, namespace)) ?? null
  }
}

function writeRecovery(userId: string, at: number, namespace: string): void {
  recoveryMemory.set(recoveryStorageKey(userId, namespace), at)
  try {
    window.sessionStorage.setItem(
      recoveryStorageKey(userId, namespace),
      String(at)
    )
  } catch {
    // sin sessionStorage queda la copia en memoria
  }
}

/** Concede el intento y lo anota, o `false` si hubo otro hace menos de 10 min. */
export function claimAccessRecovery(
  userId: string,
  namespace = 'sales-assistant'
): boolean {
  const now = Date.now()
  const last = readRecovery(userId, namespace)
  if (last !== null && now - last < ACCESS_RECOVERY_INTERVAL_MS) return false
  writeRecovery(userId, now, namespace)
  return true
}
