'use client'

import type { CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  FAMILY_COLOR,
  type MetaBrainFamily,
} from '../../lib/meta-brain/palette'
import { useBrainWords } from './brain-words'
import styles from './meta-brain.module.css'

interface Props {
  counts: Array<{ family: MetaBrainFamily; count: number }>
  hidden: ReadonlySet<MetaBrainFamily>
  onToggle: (family: MetaBrainFamily) => void
  onShowAll: () => void
  /** Riel sobre el grafo (escritorio) o fichas en fila (móvil). */
  variant: 'rail' | 'chips'
  className?: string
}

export function FamilySwatch({ family }: { family: MetaBrainFamily }) {
  if (family === 'bet')
    return (
      <span
        className={cn(styles.swatch, styles.swatchBet)}
        aria-hidden="true"
      />
    )
  if (family === 'verdict')
    return (
      <span
        className={cn(styles.swatch, styles.swatchVerdict)}
        aria-hidden="true"
      />
    )
  return (
    <span
      className={styles.swatch}
      style={{ '--swatch': FAMILY_COLOR[family] } as CSSProperties}
      aria-hidden="true"
    />
  )
}

/** Qué es cada color, cuántas ideas hay y un interruptor para ocultar la familia. */
export function FamilyLegend({
  counts,
  hidden,
  onToggle,
  onShowAll,
  variant,
  className,
}: Props) {
  const t = useTranslations('metaBrain.legend')
  const words = useBrainWords()
  return (
    <div
      role="group"
      aria-label={t('label')}
      title={t('hint')}
      className={cn(
        variant === 'rail' ? styles.legend : styles.legendChips,
        className
      )}
    >
      {variant === 'rail' ? (
        <span className={cn('mu-label', styles.legendTitle)}>{t('label')}</span>
      ) : null}
      {counts.map(({ family, count }) => (
        <button
          key={family}
          type="button"
          aria-pressed={!hidden.has(family)}
          className={styles.legendItem}
          onClick={() => onToggle(family)}
        >
          <FamilySwatch family={family} />
          <span>{words.family(family)}</span>
          <span className={styles.legendCount}>{count}</span>
        </button>
      ))}
      {hidden.size ? (
        <button type="button" className={styles.legendItem} onClick={onShowAll}>
          {t('showAll')}
        </button>
      ) : null}
    </div>
  )
}
