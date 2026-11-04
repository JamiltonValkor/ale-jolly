'use client'

import type { CSSProperties } from 'react'
import type { Icon } from '@phosphor-icons/react'
import {
  ArrowClockwise,
  Flask,
  Lightbulb,
  Storefront,
  UsersThree,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { mulberry32 } from '../../lib/meta-brain/layout'
import { CompanionStage } from '../meta-experience/companion-stage'
import type { RenderCompanion } from '../meta-experience/types'
import styles from './meta-brain.module.css'

/** Cada estrella i y la i + CLUSTERS caen en la misma familia (se unen con una línea). */
const CLUSTERS = 9

interface Star {
  x: number
  y: number
  r: number
  delay: number
}

/** Puntos del esqueleto: la forma de una constelación, siempre la misma. */
export function skySeeds(count: number): Star[] {
  const rand = mulberry32(11)
  const centers = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2
    return { x: 500 + Math.cos(angle) * 300, y: 260 + Math.sin(angle) * 170 }
  })
  centers.push({ x: 500, y: 260 })
  return Array.from({ length: count }, (_, i) => {
    const c = centers[i % centers.length]
    const angle = rand() * Math.PI * 2
    const distance = Math.sqrt(rand()) * 62
    return {
      x: c.x + Math.cos(angle) * distance,
      y: c.y + Math.sin(angle) * distance,
      r: 1.4 + rand() * 2.6,
      delay: rand() * 2.6,
    }
  })
}

function Sky({ count = 72 }: { count?: number }) {
  const stars = skySeeds(count)
  return (
    <svg
      className={styles.stateSky}
      viewBox="0 0 1000 520"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {stars
        .slice(CLUSTERS)
        .map((star, i) =>
          i % 2 === 0 ? (
            <line
              key={`l${i}`}
              x1={stars[i].x}
              y1={stars[i].y}
              x2={star.x}
              y2={star.y}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={0.8}
            />
          ) : null
        )}
      {stars.map((star, i) => (
        <circle
          key={i}
          className={styles.stateStar}
          cx={star.x}
          cy={star.y}
          r={star.r}
          fill="rgba(255,255,255,0.55)"
          style={{ animationDelay: `${star.delay}s` } as CSSProperties}
        />
      ))}
    </svg>
  )
}

/** Cargando: el esqueleto de la constelación y quién está haciendo qué. */
export function BrainLoading({
  businessName,
  className,
}: {
  businessName: string
  className?: string
}) {
  const t = useTranslations('metaBrain.states')
  return (
    <div className={cn(styles.scene, className)}>
      <div className={styles.headerText} aria-hidden="true">
        <div className={styles.skeleton} style={{ width: 120, height: 12 }} />
        <div
          className={styles.skeleton}
          style={{ width: 280, height: 44, marginTop: 14 }}
        />
        <div
          className={styles.skeleton}
          style={{ width: 'min(560px, 90%)', height: 16, marginTop: 14 }}
        />
      </div>
      <div className={styles.tiles} aria-hidden="true">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className={styles.skeleton}
            style={{ height: 112, borderRadius: 20 }}
          />
        ))}
      </div>
      <div className={styles.stateWrap}>
        <Sky />
        <p role="status" aria-busy="true" className={styles.loadingText}>
          {t('loading', { business: businessName })}
        </p>
      </div>
    </div>
  )
}

const PREVIEW: Array<{ key: string; icon: Icon }> = [
  { key: 'business', icon: Storefront },
  { key: 'market', icon: UsersThree },
  { key: 'bets', icon: Flask },
  { key: 'learned', icon: Lightbulb },
]

interface EmptyProps {
  businessName: string
  renderCompanion?: RenderCompanion
  className?: string
}

/**
 * Primeros días: se llena después de las primeras conversaciones; esto es lo
 * que va a aparecer. Tu asistente está ahí, pensando, entre las estrellas.
 */
export function BrainEmpty({
  businessName,
  renderCompanion,
  className,
}: EmptyProps) {
  const t = useTranslations('metaBrain.states.empty')
  const tCompanion = useTranslations('metaExperience.companion')
  return (
    <div className={cn(styles.stateWrap, className)}>
      <Sky count={18} />
      <div className={styles.stateCard}>
        {renderCompanion ? (
          <CompanionStage
            size="card"
            mood="thinking"
            label={tCompanion('thinking')}
            interactive
            renderCompanion={renderCompanion}
            className={styles.stateCompanion}
          />
        ) : (
          <span className={styles.iriDot} aria-hidden="true" />
        )}
        <h3 className={styles.stateTitle}>
          {t('title', { business: businessName })}
        </h3>
        <p className={styles.stateBody}>{t('body')}</p>
        <span className={cn('mu-label', styles.stateLabel)}>
          {t('willAppear')}
        </span>
        <ul className={styles.stateList}>
          {PREVIEW.map(({ key, icon: ItemIcon }) => (
            <li key={key} className={styles.stateItem}>
              <ItemIcon size={16} weight="light" aria-hidden="true" />
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Error: qué pasó y qué hacer. */
export function BrainError({
  onRetry,
  className,
}: {
  onRetry?: () => void
  className?: string
}) {
  const t = useTranslations('metaBrain.states.error')
  return (
    <div className={cn(styles.stateWrap, className)}>
      <div className={styles.stateCard} role="alert">
        <h3 className={styles.stateTitle}>{t('title')}</h3>
        <p className={styles.stateBody}>{t('body')}</p>
        {onRetry ? (
          <button
            type="button"
            className={cn(styles.primaryButton, styles.stateRetry)}
            onClick={onRetry}
          >
            <ArrowClockwise size={15} weight="light" aria-hidden="true" />
            {t('retry')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function BrainNoBusiness({ className }: { className?: string }) {
  const t = useTranslations('metaBrain.states')
  return (
    <div className={cn(styles.stateWrap, className)} style={{ minHeight: 280 }}>
      <p role="status" className={styles.stateBody}>
        {t('noBusiness')}
      </p>
    </div>
  )
}
