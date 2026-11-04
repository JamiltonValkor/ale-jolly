'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ChatsCircle, Robot } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { todayMood } from '../../lib/meta-experience/choreography'
import type { LoopModel } from '../../lib/meta-experience/loop-model'
import type { TeamModel } from '../../lib/meta-experience/team-model'
import type { DayPart } from '../../lib/meta-experience/time'
import { CompanionStage } from './companion-stage'
import { MetaChannelsCard, type CompanionLink } from './meta-channels-card'
import { MetaTeamOffice } from './team-office'
import type { RenderCompanion } from './types'
import styles from './meta-today.module.css'

export interface MetaTodayStats {
  days: number | null
  ideas: number | null
  bets: number | null
  learned: number | null
}

export interface MetaTodayViewProps {
  ownerName: string | null
  businessName: string | null
  dayPart: DayPart
  stats: MetaTodayStats
  loop: LoopModel
  /** La oficina del equipo; `null` mientras carga. */
  team?: TeamModel | null
  businessId?: string | null
  companion: CompanionLink | null
  approvalsSlot?: ReactNode
  /** En pausa: lo que lleva a conversar queda inactivo. */
  stopped?: boolean
  onTalk: () => void
  onPair: () => void
  onOpenBrain: () => void
  onLinkChannel: (prompt: string) => void
  /** El «!» de Bodega lleva a Stock › Por aprobar. */
  onOpenStock?: () => void
  renderCompanion?: RenderCompanion
  className?: string
}

function Stat({
  label,
  value,
  onOpen,
  link,
}: {
  label: string
  value: string
  onOpen?: () => void
  link?: string
}) {
  const body = (
    <>
      <span className="mu-label">{label}</span>
      <span className={styles.figure}>{value}</span>
      {link ? <span className={styles.statLink}>{link}</span> : null}
    </>
  )
  return onOpen ? (
    <button
      type="button"
      className={cn('mu-card', styles.stat)}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div className={cn('mu-card', styles.stat)}>{body}</div>
  )
}

/**
 * «Hoy»: el asistente saluda y dice cuánto lleva aprendiendo, en qué está
 * ahora, qué sabe (cifras que llevan al cerebro), su ciclo y dónde vive.
 */
export function MetaTodayView(props: MetaTodayViewProps) {
  const t = useTranslations('metaExperience')
  const { stats, loop, stopped } = props
  const business = props.businessName ?? t('start.yourBusiness')
  const figure = (value: number | null) =>
    value === null ? t('today.stats.empty') : value.toLocaleString('es-CO')
  const working = !stopped && loop.current
  const now = stopped
    ? t('header.status.stopped')
    : loop.current
      ? t(`loop.stations.${loop.current}.body`)
      : t('today.idleNow')
  // Al entrar a «Hoy», el compañero saluda una vez.
  const [officeOpen, setOfficeOpen] = useState(false)
  const [greeting] = useState(() => ({
    name: 'wave' as const,
    nonce: Date.now(),
  }))
  return (
    <div className={cn(styles.today, props.className)}>
      <section className={styles.greet}>
        <CompanionStage
          size="card"
          mood={todayMood(loop)}
          label={t('companion.label')}
          action={greeting}
          interactive
          renderCompanion={props.renderCompanion}
        />
        <div className={styles.greetCopy}>
          <h2 className={styles.greetTitle}>
            {props.ownerName
              ? t(`today.greeting.${props.dayPart}`, { name: props.ownerName })
              : t('today.greeting.noName')}
          </h2>
          <p className={styles.greetBody}>
            {t('today.together', { days: stats.days ?? 0, business })}
          </p>
          <span className={cn('mu-chip', styles.nowChip)}>
            <span
              aria-hidden
              className={cn('mu-dot', styles.nowDot, working && 'mu-halo')}
            />
            {t('today.now')} ·{' '}
            <span className={working ? 'mu-live-text' : undefined}>{now}</span>
          </span>
          <div className={styles.actions}>
            <button
              type="button"
              className="mu-btn mu-btn-p"
              onClick={props.onTalk}
              aria-disabled={stopped || undefined}
            >
              <ChatsCircle size={16} weight="light" aria-hidden />
              {t('today.talk')}
            </button>
            {props.companion?.paired ? null : (
              <button type="button" className="mu-btn" onClick={props.onPair}>
                <Robot size={16} weight="light" aria-hidden />
                {t('today.pair')}
              </button>
            )}
          </div>
        </div>
      </section>
      <section aria-label={t('today.stats.label')} className={styles.stats}>
        <Stat label={t('today.stats.days')} value={figure(stats.days)} />
        <Stat
          label={t('today.stats.ideas')}
          value={figure(stats.ideas)}
          onOpen={props.onOpenBrain}
          link={t('today.stats.seeBrain')}
        />
        <Stat
          label={t('today.stats.bets')}
          value={figure(stats.bets)}
          onOpen={props.onOpenBrain}
          link={t('today.stats.seeBrain')}
        />
        <Stat
          label={t('today.stats.learned')}
          value={figure(stats.learned)}
          onOpen={props.onOpenBrain}
          link={t('today.stats.seeBrain')}
        />
      </section>
      <div className={styles.grid}>
        <MetaTeamOffice
          team={props.team ?? null}
          businessId={props.businessId ?? ''}
          stopped={stopped}
          onTalk={props.onTalk}
          onAsk={props.onLinkChannel}
          onOpenStock={props.onOpenStock ?? props.onTalk}
          onOpenChange={setOfficeOpen}
          className={cn(styles.loopCard, officeOpen && styles.officeOpen)}
        />
        <div className={styles.column}>
          {props.approvalsSlot}
          <MetaChannelsCard
            companion={props.companion}
            onPairCompanion={props.onPair}
            onLinkChannel={props.onLinkChannel}
            stopped={stopped}
          />
        </div>
      </div>
    </div>
  )
}
