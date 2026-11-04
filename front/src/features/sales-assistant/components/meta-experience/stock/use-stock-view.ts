'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'

export const STOCK_VIEWS = ['actual', 'por-aprobar', 'pedidos'] as const
export type StockView = (typeof STOCK_VIEWS)[number]

function isStockView(value: string | null): value is StockView {
  return value !== null && (STOCK_VIEWS as readonly string[]).includes(value)
}

/** Vista de Stock en `?vista=`, sin recargar, igual que `useMetaTab`. */
export function useStockView() {
  const params = useSearchParams()
  const fromUrl = params.get('vista')
  const [view, setView] = useState<StockView>(
    isStockView(fromUrl) ? fromUrl : 'actual'
  )
  const [proposalId, setProposalId] = useState(params.get('propuesta'))
  const go = useCallback((next: StockView, proposal: string | null = null) => {
    setView(next)
    setProposalId(proposal)
    const url = new URL(window.location.href)
    url.searchParams.set('vista', next)
    if (proposal) url.searchParams.set('propuesta', proposal)
    else url.searchParams.delete('propuesta')
    window.history.replaceState(window.history.state, '', url)
  }, [])
  return { view, proposalId, go }
}
