import { create } from 'zustand'
import type { Business } from '@/types/business.types'
import { DEMO_BUSINESS } from '@/lib/local/demo'

/**
 * Stub del modo local: mismo API que el store de SaleADS (`zustand`, con
 * `getState()`), sin persistencia y con el negocio demo del contrato fijo.
 */
interface BusinessStore {
  selectedBusiness: Business | null
  setSelectedBusiness: (business: Business | null) => void
  clearBusiness: () => void
  getBusinessId: () => string | null
}

// El cliente de gateway lee el negocio de `localStorage['business-store']` (la
// forma de `zustand/persist` del store real) para el header `X-Business-Id`.
if (typeof window !== 'undefined') {
  try {
    window.localStorage.setItem(
      'business-store',
      JSON.stringify({ state: { selectedBusiness: DEMO_BUSINESS }, version: 0 })
    )
  } catch {
    // Sin almacenamiento: las llamadas salen sin X-Business-Id.
  }
}

export const useBusinessStore = create<BusinessStore>()(() => ({
  selectedBusiness: DEMO_BUSINESS,
  setSelectedBusiness: () => {},
  clearBusiness: () => {},
  getBusinessId: () => DEMO_BUSINESS.business_id,
}))

export const selectBusinessId = (state: BusinessStore): string | null =>
  state.selectedBusiness?.business_id ?? null
