'use client'

import { useTranslations } from 'next-intl'
import styles from './stock.module.css'

/** Carga: esqueleto, sin acciones. */
export function StockLoading() {
  const t = useTranslations('metaExperience.stock.states')
  return (
    <div
      className={`mu-card ${styles.skeleton}`}
      role="status"
      aria-label={t('loading')}
    >
      {[0, 1, 2, 3, 4].map(row => (
        <div key={row} className={`mu-skeleton ${styles.skeletonRow}`} />
      ))}
    </div>
  )
}

export function StockEmpty({
  kind,
}: {
  kind: 'items' | 'proposals' | 'orders'
}) {
  const t = useTranslations('metaExperience.stock.states')
  return (
    <div className={`mu-card ${styles.empty}`}>
      <h2>{t(`${kind}.title`)}</h2>
      <p>{t(`${kind}.body`)}</p>
    </div>
  )
}

/** La lectura falló sin nada que mostrar. Aclara que el stock no cambió. */
export function StockReadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('metaExperience.stock.states')
  return (
    <div className={`mu-card ${styles.empty}`} role="alert" aria-live="polite">
      <h2>{t('readError.title')}</h2>
      <p>{t('readError.body')}</p>
      <button type="button" className="mu-btn" onClick={onRetry}>
        {t('retry')}
      </button>
    </div>
  )
}

type Section = 'summary' | 'items' | 'proposals' | 'orders' | 'autonomy'

/** Lectura parcial: lo que cargó sigue a la vista, con aviso por sección. */
export function StockSectionNotice({
  section,
  onRetry,
}: {
  section: Section
  onRetry: () => void
}) {
  const t = useTranslations('metaExperience.stock.states')
  return (
    <div className={styles.partial} role="alert" aria-live="polite">
      <p>{t(`partial.${section}`)}</p>
      <button type="button" className="mu-btn" onClick={onRetry}>
        {t('retry')}
      </button>
    </div>
  )
}
