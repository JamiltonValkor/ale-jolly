'use client'

// TDD-SKIP: composición de ApprovalDecision; cubierta por approval-view.test.tsx
import { useFormatter, useTranslations } from 'next-intl'
import { SaCard } from '@/shared/components/sa-card'
import { activationOutcome, approveCopy } from '../../lib/agent-activation-copy'
import { formatMoney } from '../../lib/format-money'
import type { AgentActivationDetails, Approval } from '../../types'
import { ApprovalDecision } from './approval-decision'

interface Props {
  approval: Approval
  details: AgentActivationDetails
  canDecide: boolean
  isPending: boolean
  onDecide: (decision: 'approve' | 'reject') => void
}

/**
 * Aprobar o rechazar el encendido con un botón y confirmación, sin código
 * (D21). Si supera el presupuesto, el botón dice a cuánto sube (D13, D23).
 * La decisión la ejecuta el servidor.
 */
export function AgentActivationDecision({
  approval,
  details,
  canDecide,
  isPending,
  onDecide,
}: Props) {
  const t = useTranslations('salesAssistant.approvals.agentActivation')
  const format = useFormatter()
  if (!canDecide) {
    const outcome = activationOutcome(approval, details)
    const raised = details.budget.proposed_monthly
    return (
      <SaCard
        variant="filled"
        role="status"
        className="flex flex-col gap-1 p-6"
      >
        <p className="text-sa-text-secondary text-sm">
          {t(outcome.key as 'outcome.executed')}
        </p>
        {outcome.budgetRaised && raised ? (
          <p className="text-sa-text-secondary text-sm">
            {t('budgetRaised', { amount: formatMoney(format, raised) })}
          </p>
        ) : null}
      </SaCard>
    )
  }
  const copy = approveCopy(details)
  const amount = copy.key === 'approve' ? null : formatMoney(format, copy.money)
  return (
    <ApprovalDecision
      approvalId={approval.id}
      itemName={details.campaign.name}
      isPending={isPending}
      codeRequired={false}
      copyKey="agentActivation"
      approveLabel={
        amount ? t(copy.key as 'approveRaise', { amount }) : undefined
      }
      approveDescription={
        amount ? t('confirmApprove.raise', { amount }) : undefined
      }
      onDecide={decision => onDecide(decision)}
    />
  )
}
