'use client'

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSelectBusiness } from '@/hooks/mutations/use-business-mutations'
import { queryKeys } from '@/hooks/queries/keys'
import { businessApi } from '@/lib/api/business.api'
import { useBusinessStore } from '@/store/use-business-store'
import type { BusinessListResponse } from '@/types/business.types'

function serverSelectedId(data: BusinessListResponse): string | null {
  const flagged = data.businesses.find(business => business.is_selected)
  if (flagged) return flagged.business_id
  const byId = data.businesses.find(
    business => business.business_id === data.selected_business_id
  )
  return byId?.business_id ?? null
}

/**
 * Cuando el asistente cambia de negocio por el MCP (`select_business` o
 * `create_business`), el back ya marcó el nuevo negocio activo. Esta función
 * relee la lista y, si cambió, aplica el cambio con `useSelectBusiness`: el
 * mismo flujo del selector de la web (store, `X-Business-Id` y caches). Es
 * idempotente en el back porque re-selecciona el negocio que ya está activo.
 * Si algo falla no se muestra nada: la web se alinea en la próxima carga.
 */
export function useSalesAssistantBusinessSync(): () => Promise<void> {
  const queryClient = useQueryClient()
  const { mutate: selectBusiness } = useSelectBusiness()

  return useCallback(async () => {
    const previousId =
      useBusinessStore.getState().selectedBusiness?.business_id ?? null
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.businesses.list(),
        queryFn: () => businessApi.listBusinesses(),
        staleTime: 0,
      })
      const nextId = serverSelectedId(data)
      if (nextId && nextId !== previousId) selectBusiness(nextId)
    } catch {
      // Silencioso a propósito: el chat no depende de esta sincronización.
    }
  }, [queryClient, selectBusiness])
}
