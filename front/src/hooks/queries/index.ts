'use client'

import { useBusinessStore } from '@/store/use-business-store'

/**
 * Stub del modo local: el negocio demo es del usuario demo, así que el id
 * «reconciliado» es el del store fijo.
 */
export function useReconciledBusinessId(): string | null {
  return useBusinessStore(state => state.selectedBusiness?.business_id ?? null)
}

export function useSelectedBusinessId(): string | null {
  return useReconciledBusinessId()
}
