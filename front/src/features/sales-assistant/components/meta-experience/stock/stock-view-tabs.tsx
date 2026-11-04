'use client'

import { useRef, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { STOCK_VIEWS, type StockView } from './use-stock-view'
import styles from './stock.module.css'

const LABEL = {
  actual: 'actual',
  'por-aprobar': 'porAprobar',
  pedidos: 'pedidos',
} as const

interface Props {
  idPrefix: string
  value: StockView
  pending: number
  onChange: (view: StockView) => void
}

/** Las tres vistas, con flechas, Inicio y Fin como el dock. */
export function StockViewTabs({ idPrefix, value, pending, onChange }: Props) {
  const t = useTranslations('metaExperience.stock.views')
  const refs = useRef<Partial<Record<StockView, HTMLButtonElement | null>>>({})
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = STOCK_VIEWS.indexOf(value)
    const size = STOCK_VIEWS.length
    const target: Record<string, number> = {
      ArrowRight: (index + 1) % size,
      ArrowLeft: (index - 1 + size) % size,
      Home: 0,
      End: size - 1,
    }
    const next = STOCK_VIEWS[target[event.key]]
    if (!next) return
    event.preventDefault()
    // Las flechas del panel no deben mover también el dock.
    event.stopPropagation()
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label={t('label')} className={styles.seg}>
      {STOCK_VIEWS.map(view => (
        <button
          key={view}
          ref={node => {
            refs.current[view] = node
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-stock-tab-${view}`}
          aria-selected={view === value}
          aria-controls={`${idPrefix}-stock-view`}
          tabIndex={view === value ? 0 : -1}
          onClick={() => onChange(view)}
          onKeyDown={move}
        >
          {t(LABEL[view])}
          {view === 'por-aprobar' && pending > 0 ? (
            <span className={styles.badge}>{pending}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
