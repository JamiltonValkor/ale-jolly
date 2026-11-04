'use client'

import type { CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { FAMILY_COLOR, familyOf } from '../../lib/meta-brain/palette'
import { useBrainWords } from './brain-words'
import type { MetaBrainNode } from './types'
import styles from './meta-brain.module.css'

interface Props {
  node: MetaBrainNode
  x: number
  y: number
  /** Cerca del borde derecho se abre hacia la izquierda. */
  flip: boolean
  className?: string
}

/** Etiqueta flotante del hover: familia, la idea y una línea de contexto. */
export function NodeTooltip({ node, x, y, flip, className }: Props) {
  const t = useTranslations('metaBrain.graph')
  const words = useBrainWords()
  const family = familyOf(node.family)
  return (
    <div
      aria-hidden="true"
      className={cn(styles.tooltip, flip && styles.tooltipFlip, className)}
      style={{ left: x, top: y } as CSSProperties}
    >
      <span className={styles.tooltipFamily}>
        <span
          className={styles.swatch}
          style={{ '--swatch': FAMILY_COLOR[family] } as CSSProperties}
        />
        {words.family(family)}
      </span>
      <p className={styles.tooltipLabel}>{node.label}</p>
      <p className={styles.tooltipLine}>{node.summary || t('tooltipOpen')}</p>
    </div>
  )
}
