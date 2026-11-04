'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSelectBusiness } from '@/hooks/mutations/use-business-mutations'
import { useBusinessStore } from '@/store/use-business-store'

/** Quita `negocio` de la URL: ya cumplió, y el selector vuelve a mandar. */
function consumeLink() {
  const url = new URL(window.location.href)
  url.searchParams.delete('negocio')
  window.history.replaceState(window.history.state, '', url)
}

/**
 * Enlace profundo con `negocio=<id>` (A3): si Stock lo habilita, cambia al
 * negocio del enlace. Devuelve `true` mientras el enlace no se pueda abrir. Un
 * negocio ajeno nunca se consume: la pestaña cae en Hoy sin decir si existe.
 */
export function useStockBusinessLink(enabledIds: readonly string[] | null) {
  const params = useSearchParams()
  const negocio = params.get('tab') === 'stock' ? params.get('negocio') : null
  const selected = useBusinessStore(
    state => state.selectedBusiness?.business_id ?? null
  )
  const { mutate: selectBusiness } = useSelectBusiness()
  const requested = useRef(false)
  // `replaceState` con el estado de Next no actualiza `useSearchParams`.
  const [consumed, setConsumed] = useState(false)
  const enabled = !!negocio && !!enabledIds?.includes(negocio)
  if (enabled && selected === negocio && !consumed) setConsumed(true)
  useEffect(() => {
    if (consumed) consumeLink()
    else if (enabled && negocio && !requested.current) {
      requested.current = true
      selectBusiness(negocio)
    }
  }, [consumed, enabled, negocio, selectBusiness])
  return negocio !== null && !consumed
}
