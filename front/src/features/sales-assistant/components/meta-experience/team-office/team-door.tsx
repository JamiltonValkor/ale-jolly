'use client'

import { useTranslations } from 'next-intl'
import type { TeamModel } from '../../../lib/meta-experience/team-model'
import { MuseSprite } from './muse-sprite'
import styles from './team-office.module.css'

interface Props {
  team: TeamModel | null
  controls: string
  onOpen: () => void
}

const COUNTS = ['working', 'waiting', 'blocked', 'resting'] as const

/** La puerta cerrada: quién está y quién te espera, sin entrar. */
export function TeamDoor({ team, controls, onOpen }: Props) {
  const t = useTranslations('metaExperience.office')
  const busy =
    !!team &&
    team.summary.working + team.summary.waiting + team.summary.blocked > 0
  return (
    <button
      type="button"
      className={styles.door}
      aria-expanded={false}
      aria-controls={controls}
      onClick={onOpen}
    >
      <span className={styles.doorArt} aria-hidden>
        <span className={styles.doorPanel}>
          <span className={styles.doorWindow}>
            {team?.members.slice(0, 3).map(member => (
              <MuseSprite
                key={member.role}
                role={member.role}
                state={member.state}
                size={32}
              />
            ))}
          </span>
          <span className={styles.doorKnob} />
          {team && team.summary.waiting > 0 ? (
            <span className={styles.bubble} data-state="waiting">
              !
            </span>
          ) : null}
        </span>
      </span>
      <span className={styles.doorCopy}>
        <span className="mu-label">{t('title')}</span>
        <span className={styles.doorTitle}>{t('door.open')}</span>
        {!team ? (
          <span className={styles.doorHint}>{t('door.loading')}</span>
        ) : busy ? (
          <span className={styles.doorCounts}>
            {COUNTS.filter(key => team.summary[key] > 0).map(key => (
              <span key={key} data-state={key} className={styles.doorCount}>
                {t(`door.${key}`, { count: team.summary[key] })}
              </span>
            ))}
          </span>
        ) : (
          <span className={styles.doorHint}>{t('door.allResting')}</span>
        )}
        <span className={styles.doorHint}>{t('door.hint')}</span>
      </span>
    </button>
  )
}
