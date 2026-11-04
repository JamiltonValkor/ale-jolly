'use client'

import Link from 'next/link'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { SaAgentBadge } from '@/shared/components/sa-agent-badge'
import { SaBadge } from '@/shared/components/sa-badge'
import { STATE_TONE, stateKey } from '../lib/agent-trace'
import type { AgentAction } from '../types'
import { useAgentApprovalHref } from './approvals-path'
import { useAgentActionPhrase } from './agent-action-trace'

interface Props {
  action: AgentAction
  onOpenTrace: (action: AgentAction, phrase: string) => void
}

const linkClass = 'text-sa-agent text-xs underline-offset-2 hover:underline'

/**
 * Un paso del equipo autónomo en lenguaje simple (MAN-001, MAN-016): hora,
 * sello, frase, estado, resultado o error de Meta tal cual, y enlaces a la
 * campaña, a la aprobación pendiente y a la traza. Solo lectura.
 */
export function AgentActivityItem({ action, onOpenTrace }: Props) {
  const t = useTranslations('autonomousTeam')
  const format = useFormatter()
  const locale = useLocale()
  const phrase = useAgentActionPhrase(action)
  const approvalHref = useAgentApprovalHref(action.approval_id ?? '')
  const state = stateKey(action.state)
  const failed = state === 'failed' || state === 'partial'
  return (
    <li className="border-sa-border-default flex flex-col gap-2 border-b py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <time
          dateTime={action.created_at}
          className="text-sa-text-tertiary text-xs"
        >
          {format.dateTime(new Date(action.created_at), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </time>
        <SaAgentBadge />
        <SaBadge variant={STATE_TONE[state]} size="sm" className="ml-auto">
          {t(`state.${state}`)}
        </SaBadge>
      </div>
      <p className="text-sa-text-primary text-sm font-medium break-words">
        {phrase}
      </p>
      {action.outcome_summary ? (
        <p
          className={`${failed ? 'text-sa-state-error' : 'text-sa-text-secondary'} text-sm break-words`}
        >
          {action.outcome_summary}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-4">
        {action.campaign_id ? (
          <Link
            href={`/${locale}/dashboard/strategies/${action.campaign_id}`}
            className={linkClass}
          >
            {t('activity.viewCampaign')}
          </Link>
        ) : null}
        {state === 'awaiting_approval' && action.approval_id ? (
          <Link href={approvalHref} className={linkClass}>
            {t('activity.viewApproval')}
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => onOpenTrace(action, phrase)}
          className={linkClass}
        >
          {t('activity.viewTrace')}
        </button>
      </div>
    </li>
  )
}
