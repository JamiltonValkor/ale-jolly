'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'

import styles from './robot-screen.module.css'

/** Isotipo de Saleads con la iridiscencia de la IA girando por dentro. */
export function RobotIsotype({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn(styles.iso, className)}>
      <span className={styles.isoSpin} />
    </span>
  )
}

interface TopbarProps {
  status: string
  tone: 'live' | 'warn' | 'ok'
}

/** Arriba: «Meta Assistant · Saleads» a la izquierda; qué está pasando a la derecha. */
export function RobotTopbar({ status, tone }: TopbarProps) {
  const t = useTranslations('companion.brand')
  return (
    <div className={styles.topbar}>
      <span className={styles.lockup}>
        <RobotIsotype className={styles.lockupIso} />
        <span>{t('product')}</span>
        <span className={styles.lockupBy}>· {t('company')}</span>
      </span>
      <span role="status" className={styles.status}>
        <span
          className={cn(
            styles.dot,
            tone === 'live' && styles.dotLive,
            tone === 'warn' && styles.dotWarn,
            tone === 'ok' && 'text-[var(--mu-ok)]'
          )}
        />
        {status}
      </span>
    </div>
  )
}
