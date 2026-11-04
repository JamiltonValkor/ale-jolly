'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type {
  TeamMember,
  TeamModel,
} from '../../../lib/meta-experience/team-model'
import { TeamDoor } from './team-door'
import { TeamMemberDialog, type TeamMemberActions } from './team-member-dialog'
import { TeamOffice } from './team-office'
import styles from './team-office.module.css'

interface Props extends TeamMemberActions {
  /** `null` mientras carga: la puerta no inventa conteos. */
  team: TeamModel | null
  businessId: string
  onOpenChange?: (open: boolean) => void
  className?: string
}

/**
 * La oficina del equipo en «Hoy»: puerta cerrada con resumen, que se abre en
 * el mismo lugar y deja tocar a cada agente.
 */
export function MetaTeamOffice({
  team,
  businessId,
  onOpenChange,
  className,
  ...actions
}: Props) {
  const officeId = useId()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<TeamMember | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const opened = useRef(false)
  // Al abrir, la oficina entra en vista; al cerrar, el foco vuelve a la puerta.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (open) wrap.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    if (opened.current)
      wrap
        .querySelector<HTMLElement>(open ? '[data-office-focus]' : 'button')
        ?.focus({ preventScroll: true })
    opened.current = true
  }, [open])
  const toggle = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  // La ficha sigue al dato vivo del mismo agente.
  const current = selected
    ? (team?.members.find(item => item.role === selected.role) ?? selected)
    : null
  return (
    <div
      ref={wrapRef}
      className={cn('mu-card', styles.wrap, className)}
      data-open={open}
    >
      {open && team ? (
        <div id={officeId} className={styles.opening}>
          <TeamOffice
            team={team}
            businessId={businessId}
            stopped={actions.stopped}
            onSelect={setSelected}
            onClose={() => toggle(false)}
            onStart={actions.onTalk}
          />
        </div>
      ) : (
        <TeamDoor
          team={team}
          controls={officeId}
          onOpen={() => (team ? toggle(true) : undefined)}
        />
      )}
      {current ? (
        <TeamMemberDialog
          member={current}
          businessId={businessId}
          onClose={() => setSelected(null)}
          {...actions}
          onAsk={prompt => {
            setSelected(null)
            actions.onAsk(prompt)
          }}
          onOpenStock={() => {
            setSelected(null)
            actions.onOpenStock()
          }}
        />
      ) : null}
    </div>
  )
}
