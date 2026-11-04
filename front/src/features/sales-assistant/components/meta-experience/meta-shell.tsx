'use client'

import type { ReactNode } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import styles from './meta-experience.module.css'

export type MetaShellStatus =
  | 'ready'
  | 'preparing'
  | 'stopped'
  | 'failed'
  | 'none'
  | 'deleting'

const TONE: Record<MetaShellStatus, 'ok' | 'aviso' | 'mal' | 'neutral'> = {
  ready: 'ok',
  preparing: 'neutral',
  stopped: 'neutral',
  failed: 'mal',
  none: 'neutral',
  deleting: 'neutral',
}

interface Props {
  status: MetaShellStatus | null
  /** Título y subtítulo grandes; las pantallas con héroe propio los apagan. */
  showTitle?: boolean
  actions?: ReactNode
  /** Van en un dock flotante al pie, no en el encabezado. */
  tabs?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Marco de Meta Assistant: marca (logo de Meta y el de Saleads en blanco),
 * estado del asistente siempre visible y acciones de administrar.
 * Las pestañas van primero en el DOM (el tablist antes de su panel) pero se
 * ven al pie, en el dock.
 */
export function MetaShell({
  status,
  showTitle = true,
  actions,
  tabs,
  children,
  className,
}: Props) {
  const t = useTranslations('metaExperience.header')
  return (
    <div
      className={cn(styles.page, className)}
      data-dock={tabs ? '' : undefined}
    >
      {tabs ? <div className={styles.dockBar}>{tabs}</div> : null}
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span role="img" aria-label={t('eyebrow')} className={styles.brand}>
            <Image
              src="/agent-chat/logo-meta.svg"
              alt=""
              width={30}
              height={30}
              className={styles.metaLogo}
            />
            <span aria-hidden className={styles.brandDivider} />
            <span aria-hidden className={styles.isotype} />
          </span>
          <span className={styles.headerActions}>
            {status ? (
              <span
                className={cn('mu-chip', styles.statusChip)}
                data-tone={TONE[status]}
              >
                <span
                  aria-hidden
                  className={cn('mu-dot', status === 'preparing' && 'mu-halo')}
                />
                {t(`status.${status}`)}
              </span>
            ) : null}
            {actions}
          </span>
        </div>
        {showTitle ? (
          <>
            <h1 className={styles.title}>{t('title')}</h1>
            <p className={styles.subtitle}>{t('subtitle')}</p>
          </>
        ) : null}
      </header>
      {children}
    </div>
  )
}
