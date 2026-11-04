'use client'

import { useFormatter, useNow, useTranslations } from 'next-intl'
import { Sparkle, X } from '@phosphor-icons/react'
import type {
  TeamMember,
  TeamModel,
} from '../../../lib/meta-experience/team-model'
import { LoungeScene } from './room-scene'
import { TeamDesk } from './team-desk'
import styles from './team-office.module.css'

interface Props {
  team: TeamModel
  businessId: string
  stopped?: boolean
  onSelect: (member: TeamMember) => void
  onClose: () => void
  onStart: () => void
}

function Freshness({ team }: { team: TeamModel }) {
  const t = useTranslations('metaExperience.office.office')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { status, observedAt } = team.freshness
  if (status === 'error')
    return (
      <p role="status" className={styles.alert}>
        {t('error')}
      </p>
    )
  if (status === 'fresh' && observedAt)
    return (
      <span className="mu-chip">
        {t('fresh', { time: format.relativeTime(new Date(observedAt), now) })}
      </span>
    )
  return <span className="mu-chip">{t('stale')}</span>
}

/** La oficina abierta: Ale al frente y el equipo en sus puestos. */
export function TeamOffice({
  team,
  businessId,
  stopped,
  onSelect,
  onClose,
  onStart,
}: Props) {
  const t = useTranslations('metaExperience.office')
  const waiting = team.summary.waiting
  return (
    <section className={styles.office} aria-label={t('office.label')}>
      <header className={styles.officeHead}>
        <div className={styles.officeMeta}>
          <Freshness team={team} />
          {waiting > 0 ? (
            <span className={styles.waitingChip}>
              {t('office.waiting', { count: waiting })}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="mu-btn mu-btn-ghost"
          onClick={onClose}
          data-office-focus=""
        >
          <X size={15} weight="light" aria-hidden />
          {t('door.close')}
        </button>
      </header>
      <div className={styles.floor}>
        {team.members.map(member => (
          <TeamDesk
            key={member.role}
            member={member}
            businessId={businessId}
            onSelect={onSelect}
          />
        ))}
        <LoungeScene />
      </div>
      <footer className={styles.officeFoot}>
        {team.active ? (
          <p>{t('office.soon')}</p>
        ) : (
          <>
            <p>{t('office.empty')}</p>
            <button
              type="button"
              className="mu-btn mu-btn-p"
              onClick={onStart}
              aria-disabled={stopped || undefined}
            >
              <Sparkle size={16} weight="light" aria-hidden />
              {t('office.emptyCta')}
            </button>
          </>
        )}
      </footer>
    </section>
  )
}
