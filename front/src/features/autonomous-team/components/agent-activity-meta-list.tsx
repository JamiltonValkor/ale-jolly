'use client'

import Link from 'next/link'
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl'
import {
  CheckCircle,
  Hourglass,
  Lightning,
  WarningCircle,
  XCircle,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { stateKey, type KnownState } from '../lib/agent-trace'
import type { AgentAction } from '../types'
import { useAgentApprovalHref } from './approvals-path'
import { useAgentActionPhrase } from './agent-action-trace'

const COT = 'America/Bogota'

const STATE_ICON: Record<KnownState, Icon> = {
  awaiting_approval: Hourglass,
  partial: WarningCircle,
  succeeded: CheckCircle,
  approved: CheckCircle,
  failed: XCircle,
  rejected: XCircle,
  requested: Lightning,
  executing: Lightning,
  unknown: Lightning,
}

const STATE_COLOR: Partial<Record<KnownState, string>> = {
  awaiting_approval: 'var(--mu-aviso)',
  partial: 'var(--mu-aviso)',
  succeeded: 'var(--mu-ok)',
  approved: 'var(--mu-ok)',
  failed: 'var(--mu-mal)',
}

const dayKey = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: COT })

/** Agrupa por día en hora de Colombia, sin cambiar el orden del servidor. */
export function groupByDay(actions: AgentAction[]) {
  const groups: Array<{ day: string; items: AgentAction[] }> = []
  for (const action of actions) {
    const day = dayKey(action.created_at)
    const last = groups.at(-1)
    if (last?.day === day) last.items.push(action)
    else groups.push({ day, items: [action] })
  }
  return groups
}

function useDayLabel() {
  const t = useTranslations('autonomousTeam.activity.days')
  const format = useFormatter()
  const now = useNow()
  const today = dayKey(now.toISOString())
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000).toISOString())
  return (day: string) => {
    if (day === today) return t('today')
    if (day === yesterday) return t('yesterday')
    return format.dateTime(new Date(`${day}T12:00:00Z`), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: COT,
    })
  }
}

const linkClass = 'mu-btn mu-btn-ghost h-8 px-3 text-[12.5px]'
const primaryClass = 'mu-btn mu-btn-p h-8 px-3 text-[12.5px]'

function MetaActivityCard({
  action,
  onOpenTrace,
}: {
  action: AgentAction
  onOpenTrace: (action: AgentAction, phrase: string) => void
}) {
  const t = useTranslations('autonomousTeam')
  const format = useFormatter()
  const locale = useLocale()
  const phrase = useAgentActionPhrase(action)
  const approvalHref = useAgentApprovalHref(action.approval_id ?? '')
  const state = stateKey(action.state)
  const StateIcon = STATE_ICON[state]
  const failed = state === 'failed' || state === 'partial'
  return (
    <li className="mu-card flex gap-3.5 p-4">
      <span
        className="mu-tile shrink-0"
        style={{ color: STATE_COLOR[state] }}
        aria-hidden
      >
        <StateIcon size={17} weight="light" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mu-chip" style={{ color: STATE_COLOR[state] }}>
            {t(`state.${state}`)}
          </span>
          <time
            dateTime={action.created_at}
            className="text-[12.5px] text-[var(--mu-text-2)]"
          >
            {format.dateTime(new Date(action.created_at), {
              timeStyle: 'short',
              timeZone: COT,
            })}
          </time>
        </div>
        <p className="text-[15px] leading-[1.4] font-medium break-words text-[var(--mu-fg)]">
          {phrase}
        </p>
        {action.outcome_summary ? (
          <p
            className={cn(
              'text-[13.5px] leading-[1.5] break-words',
              failed ? 'text-[var(--mu-mal)]' : 'text-[var(--mu-text-2)]'
            )}
          >
            {action.outcome_summary}
          </p>
        ) : null}
        <div className="-ml-3 flex flex-wrap gap-1">
          {state === 'awaiting_approval' && action.approval_id ? (
            <Link href={approvalHref} className={primaryClass}>
              {t('activity.viewApproval')}
            </Link>
          ) : null}
          {action.campaign_id ? (
            <Link
              href={`/${locale}/dashboard/strategies/${action.campaign_id}`}
              className={linkClass}
            >
              {t('activity.viewCampaign')}
            </Link>
          ) : null}
          <button
            type="button"
            className={linkClass}
            onClick={() => onOpenTrace(action, phrase)}
          >
            {t('activity.viewTrace')}
          </button>
        </div>
      </div>
    </li>
  )
}

/** Actividad con el lenguaje de Meta Assistant: por día, una tarjeta por acción. */
export function AgentActivityMetaList({
  actions,
  onOpenTrace,
}: {
  actions: AgentAction[]
  onOpenTrace: (action: AgentAction, phrase: string) => void
}) {
  const label = useDayLabel()
  return (
    <div className="flex flex-col gap-6">
      {groupByDay(actions).map(group => (
        <section key={group.day} className="flex flex-col gap-2.5">
          <h3 className="mu-label first-letter:uppercase">
            {label(group.day)}
          </h3>
          <ul className="flex flex-col gap-2.5">
            {group.items.map(action => (
              <MetaActivityCard
                key={action.agent_action_id}
                action={action}
                onOpenTrace={onOpenTrace}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
