'use client'

import { useTranslations } from 'next-intl'
import type { TeamMember } from '../../../lib/meta-experience/team-model'
import { ROOMS } from './office-props'
import { RoomScene } from './room-scene'
import { useMemberName } from './use-member-name'
import styles from './team-office.module.css'

interface Props {
  member: TeamMember
  businessId: string
  onSelect: (member: TeamMember) => void
}

const BUBBLE: Partial<Record<TeamMember['state'], string>> = {
  waiting: '!',
  blocked: '?',
  done: '✓',
  resting: 'z',
}

/** La nota corta bajo el estado: tarea, cola, pedidos o «llega pronto». */
export function useMemberLine(member: TeamMember): string | null {
  const t = useTranslations('metaExperience.office.notes')
  if (member.task) return member.task.title
  if (member.state === 'waiting' && member.count !== null)
    return t('pending', { count: member.count })
  if (member.note === 'orders') return t('orders', { count: member.count ?? 0 })
  if (member.note) return t(member.note)
  return null
}

/** Un puesto de la oficina: la Muse, su nombre, su estado y lo que hace. */
export function TeamDesk({ member, businessId, onSelect }: Props) {
  const t = useTranslations('metaExperience.office')
  const name = useMemberName(businessId, member.role)
  const role = t(`roles.${member.role}.role`)
  const state = t(`states.${member.state}`)
  const line = useMemberLine(member)
  const bubble = BUBBLE[member.state]
  return (
    <button
      type="button"
      className={styles.desk}
      data-state={member.state}
      data-role={member.role}
      data-wide={ROOMS[member.role].width === 80 || undefined}
      aria-label={[t('desk', { name, role, state }), line]
        .filter(Boolean)
        .join('. ')}
      onClick={() => onSelect(member)}
    >
      <span className={styles.spot} aria-hidden>
        {bubble ? (
          <span className={styles.bubble} data-state={member.state}>
            {bubble}
          </span>
        ) : null}
        <RoomScene role={member.role} state={member.state} />
      </span>
      <span className={styles.deskName}>{name}</span>
      <span className={styles.deskRole}>{role}</span>
      <span className={styles.deskState} data-state={member.state}>
        <span className="mu-dot" aria-hidden />
        {state}
      </span>
      {line ? (
        <span className={styles.deskLine} title={line}>
          {line}
        </span>
      ) : null}
    </button>
  )
}
