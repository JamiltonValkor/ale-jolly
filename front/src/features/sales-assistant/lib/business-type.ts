import type { BusinessType } from '../types'

/**
 * Tipo de negocio antes de activar (MLF-001): la precarga sale del
 * `offering_type` del negocio seleccionado y la elección se guarda en
 * sessionStorage hasta que el asistente existe (entonces se manda con PUT).
 */
const KEY = (businessId: string, namespace: string) =>
  namespace === 'sales-assistant'
    ? `sa:business-type:${businessId}`
    : `${namespace}:business-type:${businessId}`
const TYPES: readonly BusinessType[] = [
  'physical_product',
  'service',
  'infoproduct',
]

export function typeFromOffering(offering: unknown): BusinessType | null {
  if (offering === 'products') return 'physical_product'
  if (offering === 'services') return 'service'
  return null
}

export function readPendingType(
  businessId: string,
  namespace = 'sales-assistant'
): BusinessType | null {
  try {
    const value = window.sessionStorage.getItem(KEY(businessId, namespace))
    return TYPES.includes(value as BusinessType)
      ? (value as BusinessType)
      : null
  } catch {
    return null
  }
}

export function savePendingType(
  businessId: string,
  type: BusinessType,
  namespace = 'sales-assistant'
): void {
  try {
    window.sessionStorage.setItem(KEY(businessId, namespace), type)
  } catch {
    // Sin sessionStorage se elige de nuevo en Habilidades: nunca bloquea.
  }
}

export function clearPendingType(
  businessId: string,
  namespace = 'sales-assistant'
): void {
  try {
    window.sessionStorage.removeItem(KEY(businessId, namespace))
  } catch {
    // nada que limpiar
  }
}
