'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { StockSummary } from '../../../types'
import type { StockView } from './use-stock-view'
import styles from './stock.module.css'

interface Props {
  summary: StockSummary | undefined
  /** Cada cifra lleva a la vista donde se resuelve. */
  onOpen?: (view: StockView) => void
}

/** Cifras del servidor tal cual llegan: el front no calcula stock. */
export function StockSummaryStats({ summary, onOpen }: Props) {
  const t = useTranslations('metaExperience.stock.summary')
  const format = useFormatter()
  const stats = [
    ['expected', summary?.unidades_esperadas, 'actual'],
    ['differences', summary?.diferencias_por_resolver, 'actual'],
    ['pending', summary?.propuestas_pendientes, 'por-aprobar'],
    ['orders', summary?.pedidos_en_curso, 'pedidos'],
  ] as const
  const lastCount = summary?.ultimo_conteo_en
  // Sin cifras no hay a dónde llevar: mientras carga no hay acciones.
  const open = summary ? onOpen : undefined
  return (
    <>
      {summary ? (
        <div className={styles.chips}>
          <span className="mu-chip">
            <span aria-hidden className={cn('mu-dot', styles.ok)} />
            {lastCount
              ? t('lastCount', {
                  date: format.dateTime(new Date(lastCount), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })
              : t('noCount')}
          </span>
          {summary.simulado ? (
            <span className="mu-chip">{t('simulated')}</span>
          ) : null}
        </div>
      ) : null}
      <section aria-label={t('label')} className={styles.stats}>
        {stats.map(([key, value, view]) => {
          const body = (
            <>
              <span className="mu-label">{t(key)}</span>
              <span className={styles.figure}>{value ?? '–'}</span>
              {open ? (
                <span className={styles.statLink}>{t(`open.${key}`)}</span>
              ) : null}
            </>
          )
          return open ? (
            <button
              key={key}
              type="button"
              className={cn('mu-card', styles.stat)}
              onClick={() => open(view)}
            >
              {body}
            </button>
          ) : (
            <div key={key} className={cn('mu-card', styles.stat)}>
              {body}
            </div>
          )
        })}
      </section>
    </>
  )
}
