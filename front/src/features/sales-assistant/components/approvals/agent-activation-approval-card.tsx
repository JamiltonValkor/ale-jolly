'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { Warning } from '@phosphor-icons/react'
import { SaAgentBadge } from '@/shared/components/sa-agent-badge'
import { SaBadge } from '@/shared/components/sa-badge'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'
import { stripAgentPrefix } from '@/shared/lib/authorship'
import type { AgentActivationDetails, Approval } from '../../types'
import {
  AdSetsSection,
  BetSection,
  BudgetSection,
  PiecesSection,
  Section,
} from './agent-activation-sections'

interface Props {
  approval: Approval
  details: AgentActivationDetails
  className?: string
}

const STATUS_VARIANT = {
  pending: 'warning',
  executing: 'info',
  executed: 'success',
  failed: 'error',
  rejected: 'default',
  expired: 'default',
  stale: 'default',
} as const

// Lo que llega en esta aprobación siempre es de la Agent API: el prefijo se quita con origin agent.
const AGENT = { authorship: { origin: 'agent' } }

/**
 * Encender lo que el equipo autónomo publicó en pausa (AAF-003, D21): qué se
 * enciende, a quién, cuánto, con qué apuesta y qué piezas. Todo sale de
 * lecturas del servicio y se pinta como texto (nunca HTML del agente).
 */
export function AgentActivationApprovalCard({
  approval,
  details,
  className,
}: Props) {
  const t = useTranslations('salesAssistant.approvals')
  const tA = useTranslations('salesAssistant.approvals.agentActivation')
  const format = useFormatter()
  const name = stripAgentPrefix(details.campaign.name, AGENT)
  return (
    <SaCard variant="filled" className={cn('gap-5 p-6', className)}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <SaAgentBadge />
          <p className="text-sa-text-secondary text-sm">{tA('title')}</p>
          <h1 className="text-sa-text-primary text-xl font-semibold break-words">
            {name}
          </h1>
        </div>
        <SaBadge
          variant={STATUS_VARIANT[approval.status]}
          className="ml-auto shrink-0"
        >
          {tA(`status.${approval.status}`)}
        </SaBadge>
      </div>
      <Section title={tA('sections.what')}>
        <p className="text-sa-text-primary text-sm">
          {[
            details.campaign.objective
              ? tA('objective', { objective: details.campaign.objective })
              : null,
            tA('adSetsCount', { count: details.ad_sets.length }),
            tA('adsCount', { count: details.ads_count }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </Section>
      {details.ad_sets.length ? <AdSetsSection details={details} /> : null}
      <BudgetSection details={details} />
      {details.budget.exceeds ? (
        <p
          role="status"
          className="bg-sa-state-warning-bg text-sa-state-warning border-sa-state-warning-border flex items-start gap-2 rounded-lg border p-3 text-sm"
        >
          <Warning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {details.budget.monthly
            ? tA('exceedsWarning')
            : tA('noBudgetWarning')}
        </p>
      ) : null}
      <BetSection details={details} />
      <PiecesSection details={details} />
      <p className="text-sa-text-tertiary text-xs">
        {t('details.effect.activate_agent_publication')}
      </p>
      <p className="text-sa-text-tertiary text-xs">
        {t('expires', {
          date: format.dateTime(new Date(approval.expires_at), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        })}
      </p>
    </SaCard>
  )
}
