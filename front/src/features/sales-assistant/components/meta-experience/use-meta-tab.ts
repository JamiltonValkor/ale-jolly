'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { META_TABS, type MetaTab } from './types'

function isMetaTab(value: string | null): value is MetaTab {
  return value !== null && (META_TABS as readonly string[]).includes(value)
}

/**
 * Pestaña activa guardada en `?tab=` (se puede compartir y sobrevive a la
 * recarga) sin navegar: `history.replaceState` no vuelve a pedir la página.
 *
 * Stock se habilita después del primer render, así que un enlace `?tab=stock`
 * se aplica cuando deja de estar oculta, salvo que la persona ya haya cambiado
 * de pestaña. `stockLinkPending`: el enlace aún no puede abrirse (su negocio no
 * está listo o es ajeno). Las demás pestañas siguen como siempre.
 */
export function useMetaTab(
  fallback: MetaTab,
  hidden: readonly MetaTab[] = [],
  stockLinkPending = false
) {
  const params = useSearchParams()
  const fromUrl = params.get('tab')
  const [tab, setTab] = useState<MetaTab>(() =>
    isMetaTab(fromUrl) && !hidden.includes(fromUrl) ? fromUrl : fallback
  )
  const [touched, setTouched] = useState(false)
  const change = useCallback((next: MetaTab) => {
    setTouched(true)
    setTab(next)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', next)
    window.history.replaceState(window.history.state, '', url)
  }, [])
  const held = !touched && stockLinkPending
  const arrived = !touched && fromUrl === 'stock'
  const wanted = arrived ? 'stock' : tab
  const blocked = hidden.includes(wanted) || (held && wanted === 'stock')
  return [blocked ? fallback : wanted, change] as const
}
