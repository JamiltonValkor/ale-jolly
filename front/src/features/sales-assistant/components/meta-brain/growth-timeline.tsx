'use client'

import type { CSSProperties } from 'react'
import { Pause, Play } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  captionFor,
  type BrainTimeline,
  type Milestone,
} from '../../lib/meta-brain/time'
import styles from './meta-brain.module.css'

interface Props {
  timeline: BrainTimeline
  day: number
  onDayChange: (day: number) => void
  playing: boolean
  onPlayToggle: () => void
  businessName: string
  /** Lo más importante que aprendió ese día (si no hay hito que contar). */
  dayHighlight?: string | null
  className?: string
}

function useCaption(businessName: string) {
  const t = useTranslations('metaBrain.timeline')
  return (milestone: Milestone) =>
    t('caption', {
      day: milestone.day,
      text: t(`milestones.${milestone.kind}`, {
        business: businessName,
        count: milestone.count,
      }),
    })
}

function Bars({ timeline, day }: { timeline: BrainTimeline; day: number }) {
  const max = Math.max(1, ...timeline.newPerDay)
  const marks = new Set(timeline.milestones.map(m => m.day))
  return (
    <div className={styles.bars} aria-hidden="true">
      {timeline.newPerDay.map((count, index) => (
        <span
          key={index}
          className={styles.bar}
          data-on={index + 1 <= day ? 'true' : 'false'}
          data-current={index + 1 === day ? 'true' : 'false'}
          style={
            { height: `${14 + 86 * Math.sqrt(count / max)}%` } as CSSProperties
          }
        >
          {marks.has(index + 1) ? <span className={styles.barMark} /> : null}
        </span>
      ))}
    </div>
  )
}

/**
 * La línea de tiempo: «Día 1 … Hoy». Cada barra es lo que aprendió ese día;
 * los puntos son hitos. Reproducir hace crecer el grafo día por día.
 */
export function GrowthTimeline({
  timeline,
  day,
  onDayChange,
  playing,
  onPlayToggle,
  businessName,
  dayHighlight,
  className,
}: Props) {
  const t = useTranslations('metaBrain.timeline')
  const caption = useCaption(businessName)
  const total = timeline.totalDays
  const ideas = timeline.cumulative[day - 1] ?? 0
  const milestone = captionFor(timeline, day)
  const PlayIcon = playing ? Pause : Play
  return (
    <div
      role="group"
      aria-label={t('label')}
      className={cn(styles.timeline, className)}
    >
      <button
        type="button"
        className={styles.playButton}
        aria-label={playing ? t('pause') : t('play')}
        onClick={onPlayToggle}
      >
        <PlayIcon size={17} weight="fill" aria-hidden="true" />
      </button>
      <div className={styles.dayBlock}>
        <span className={styles.dayValue}>{t('dayOf', { day, total })}</span>
        <span className={styles.dayMeta}>
          {t('newThatDay', { count: timeline.newPerDay[day - 1] ?? 0 })}
        </span>
      </div>
      <div className={styles.scrubber}>
        <Bars timeline={timeline} day={day} />
        <input
          type="range"
          className={styles.range}
          min={1}
          max={total}
          step={1}
          value={day}
          aria-label={t('slider')}
          aria-valuetext={t('valueText', { day, total, ideas })}
          onChange={event => onDayChange(Number(event.target.value))}
        />
        <div className={styles.scrubEnds} aria-hidden="true">
          <span>{t('first')}</span>
          <span>{t('today')}</span>
        </div>
      </div>
      <p className={styles.caption} aria-live="polite">
        {milestone ? (
          <span key={`m${milestone.day}`} className={styles.captionText}>
            {caption(milestone)}
          </span>
        ) : dayHighlight ? (
          <span key={`d${day}`} className={styles.captionText}>
            {t('caption', { day, text: dayHighlight })}
          </span>
        ) : null}
      </p>
    </div>
  )
}
