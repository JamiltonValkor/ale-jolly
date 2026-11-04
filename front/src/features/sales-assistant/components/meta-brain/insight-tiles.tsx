'use client'

import type { Icon } from '@phosphor-icons/react'
import {
  Check,
  Flask,
  Graph,
  Lightbulb,
  SealQuestion,
} from '@phosphor-icons/react'
import { useId } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { InsightCounts, InsightFocus } from '../../lib/meta-brain/focus'
import { AnimatedNumber } from './animated-number'
import styles from './meta-brain.module.css'

interface Props {
  counts: InsightCounts
  week: number
  focus: InsightFocus
  onFocus: (focus: InsightFocus) => void
  reduced: boolean
  className?: string
}

type TileKey = Exclude<InsightFocus, 'all'> | 'ideas'

const TILES: Array<{ key: TileKey; icon: Icon }> = [
  { key: 'ideas', icon: Graph },
  { key: 'bets', icon: Flask },
  { key: 'learned', icon: Lightbulb },
  { key: 'toConfirm', icon: SealQuestion },
]

function useTileText(counts: InsightCounts, week: number) {
  const t = useTranslations('metaBrain.tiles')
  return (key: TileKey): { value: number; hint: string } => {
    if (key === 'ideas')
      return { value: counts.ideas, hint: t('ideas.hint', { count: week }) }
    if (key === 'bets')
      return {
        value: counts.bets,
        hint: counts.bets
          ? t('bets.hint', {
              testing: counts.testing,
              launched: counts.launched,
              planned: counts.planned,
            })
          : t('bets.none'),
      }
    if (key === 'learned')
      return {
        value: counts.learned,
        hint: counts.learned
          ? t('learned.hint', {
              worked: counts.worked,
              didNotWork: counts.didNotWork,
            })
          : t('learned.none'),
      }
    return {
      value: counts.toConfirm,
      hint: counts.toConfirm ? t('toConfirm.hint') : t('toConfirm.none'),
    }
  }
}

/**
 * Cuatro cifras de tablero. Elegir una enfoca su grupo en el grafo y en las
 * secciones; «Ideas que conoce» (o repetir la elegida) vuelve a verlo todo.
 */
export function InsightTiles({
  counts,
  week,
  focus,
  onFocus,
  reduced,
  className,
}: Props) {
  const t = useTranslations('metaBrain.tiles')
  const locale = useLocale()
  const text = useTileText(counts, week)
  const hintId = useId()
  return (
    <section aria-label={t('label')} className={cn(styles.tiles, className)}>
      <p id={hintId} className={styles.srOnly}>
        {t('hint')}
      </p>
      {TILES.map(({ key, icon: TileIcon }) => {
        const pressed = key === 'ideas' ? focus === 'all' : focus === key
        const { value, hint } = text(key)
        return (
          <button
            key={key}
            type="button"
            className={styles.tile}
            aria-pressed={pressed}
            aria-describedby={hintId}
            onClick={() => onFocus(key === 'ideas' || pressed ? 'all' : key)}
          >
            <span className={styles.tileIcon} aria-hidden="true">
              <TileIcon size={17} weight="light" />
            </span>
            <span className={styles.tileBody}>
              <span className="mu-label">{t(`${key}.title`)}</span>
              <AnimatedNumber
                className={styles.tileValue}
                value={value}
                reduced={reduced}
                locale={locale === 'es' ? 'es-CO' : locale}
              />
              <span className={styles.srOnly}>{value}</span>
              <span className={styles.tileHint}>{hint}</span>
            </span>
            {pressed && key !== 'ideas' ? (
              <Check
                className={styles.tileCheck}
                size={14}
                weight="bold"
                aria-hidden="true"
              />
            ) : null}
          </button>
        )
      })}
    </section>
  )
}
