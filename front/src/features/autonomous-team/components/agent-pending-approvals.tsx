'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { SealCheck } from '@phosphor-icons/react'
import { useReconciledBusinessId } from '@/hooks/queries'
import { useAgentActions } from '../hooks/use-autonomous-team-queries'
import type { AgentAction } from '../types'
import { useAgentActionPhrase } from './agent-action-trace'
import { mergePages } from './agent-activity-feed'
import { useAgentApprovalHref } from './approvals-path'

const VISIBLE = 3

function PendingRow({ action }: { action: AgentAction }) {
  const t = useTranslations('autonomousTeam.pending')
  const phrase = useAgentActionPhrase(action)
  const href = useAgentApprovalHref(action.approval_id ?? '')
  return (
    <li className="mu-row">
      <div className="min-w-0">
        <p className="text-[14.5px] leading-[1.35] font-medium">{phrase}</p>
        {action.request_summary ? (
          <p className="truncate text-[13px] text-[var(--mu-text-ap)]">
            {action.request_summary}
          </p>
        ) : null}
      </div>
      <Link href={href} className="mu-btn mu-btn-p ml-auto shrink-0">
        {t('review')}
      </Link>
    </li>
  )
}

/**
 * «Necesita tu visto bueno» para el resumen del asistente: lo que el equipo
 * autónomo dejó esperando aprobación, con enlace directo. Sin pendientes no
 * ocupa lugar. Usa el kit visual de Meta Assistant (clases `mu-*`).
 */
export function AgentPendingApprovals() {
  const t = useTranslations('autonomousTeam.pending')
  const business = useReconciledBusinessId()
  const query = useAgentActions(business)
  const pages = query.data?.pages
  const pending = useMemo(
    () =>
      mergePages(pages ?? []).filter(
        action => action.state === 'awaiting_approval' && action.approval_id
      ),
    [pages]
  )
  if (pending.length === 0) return null
  const rest = pending.length - VISIBLE
  return (
    <section className="mu-card" aria-labelledby="agent-pending-title">
      <div className="mu-head">
        <span className="mu-tile" aria-hidden>
          <SealCheck size={17} weight="light" />
        </span>
        <div>
          <h3
            id="agent-pending-title"
            className="text-[15.5px] leading-[1.3] font-semibold tracking-[-0.012em]"
          >
            {t('title')}
          </h3>
          <p className="text-[13px] text-[var(--mu-text-ap)]">
            {t('subtitle')}
          </p>
        </div>
        <span className="mu-chip ml-auto self-start">{pending.length}</span>
      </div>
      <ul>
        {pending.slice(0, VISIBLE).map(action => (
          <PendingRow key={action.agent_action_id} action={action} />
        ))}
      </ul>
      {rest > 0 ? (
        <div className="mu-foot">
          <span className="text-[12.5px] text-[var(--mu-text-te)]">
            {t('more', { count: rest })}
          </span>
        </div>
      ) : null}
    </section>
  )
}
