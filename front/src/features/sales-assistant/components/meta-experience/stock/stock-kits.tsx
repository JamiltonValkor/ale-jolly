'use client'

import { useTranslations } from 'next-intl'
import type { StockKit } from '../../../types'
import styles from './stock.module.css'

interface Props {
  kits: StockKit[]
}

/** R2: un kit no tiene unidades propias, salen de sus componentes. */
export function StockKits({ kits }: Props) {
  const t = useTranslations('metaExperience.stock.kits')
  if (kits.length === 0) return null
  return (
    <section className={`mu-card ${styles.kits}`} aria-label={t('label')}>
      <p className={styles.kitHead}>{t('head')}</p>
      <ul className={styles.kitList}>
        {kits.map(kit => (
          <li key={kit.id} className={styles.kit}>
            <div className={styles.kitName}>
              <span className={styles.pname}>{kit.nombre}</span>
              <span className={styles.pmeta}>
                {kit.componentes
                  .map(part =>
                    t('component', { count: part.cantidad, name: part.nombre })
                  )
                  .join(' + ')}
              </span>
            </div>
            <span className={styles.kitReach}>
              {t('reach', { count: kit.alcanzan })}
            </span>
            <span className={styles.kitState}>
              {kit.estado === 'activo' ? t('active') : kit.estado}
              {kit.simulado ? (
                <span className="mu-chip">{t('simulated')}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
