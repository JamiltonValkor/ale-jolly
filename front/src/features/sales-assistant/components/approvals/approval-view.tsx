'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useBreadcrumbStore } from '@/store/use-breadcrumb-store'
import { SaCard } from '@/shared/components/sa-card'
import { useApproval } from '../../hooks/use-orqa-queries'
import { useDecideApproval } from '../../hooks/use-orqa-mutations'
import { approvalErrorKey } from '../../lib/approval-error'
import { useAssistantFeatureEnabled } from '../../runtime'
import { activationDetails } from '../../lib/agent-activation-copy'
import { AgentActivationApprovalCard } from './agent-activation-approval-card'
import { AgentActivationDecision } from './agent-activation-decision'
import { ApprovalCard } from './approval-card'
import { ApprovalDecision } from './approval-decision'

interface Props {
  approvalId: string
}

function Notice({
  text,
  role = 'status',
}: {
  text: string
  role?: 'status' | 'alert'
}) {
  return (
    <SaCard variant="filled" role={role} className="p-6">
      <p className="text-sa-text-secondary text-sm">{text}</p>
    </SaCard>
  )
}

/**
 * Página de aprobación (OSF-003): el dueño ve exactamente qué se instala y
 * decide una sola vez con su sesión. La instalación la ejecuta el servidor.
 */
export function ApprovalView({ approvalId }: Props) {
  const t = useTranslations('salesAssistant')
  const enabled = useAssistantFeatureEnabled()
  const approval = useApproval(approvalId)
  const decide = useDecideApproval(approvalId)
  const setOverride = useBreadcrumbStore(state => state.setOverride)
  const clearOverride = useBreadcrumbStore(state => state.clearOverride)
  // H21: el breadcrumb no muestra el uuid de la aprobación.
  useEffect(() => {
    setOverride(approvalId, t('approvals.breadcrumb'), true)
    return () => clearOverride(approvalId)
  }, [approvalId, setOverride, clearOverride, t])

  if (!enabled) return <Notice text={t('approvals.errors.notFound')} />
  if (approval.isPending) return <Notice text={t('approvals.loading')} />
  if (approval.isError || !approval.data)
    return <Notice role="alert" text={t(approvalErrorKey(approval.error))} />

  // El servidor presenta una pendiente vencida como `expired` (OSB-013).
  const current = decide.data ?? approval.data
  const canDecide = current.status === 'pending'
  // AAF-003 (D21): el encendido del agente tiene su propia tarjeta y se aprueba sin código.
  const activation = activationDetails(current)
  if (activation)
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <AgentActivationApprovalCard approval={current} details={activation} />
        {decide.isError ? (
          <Notice role="alert" text={t(approvalErrorKey(decide.error))} />
        ) : null}
        <AgentActivationDecision
          approval={current}
          details={activation}
          canDecide={canDecide && !decide.isSuccess}
          isPending={decide.isPending}
          onDecide={decision => decide.mutate({ decision })}
        />
      </div>
    )

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <ApprovalCard approval={current} />
      {decide.isError ? (
        <Notice role="alert" text={t(approvalErrorKey(decide.error))} />
      ) : null}
      {canDecide && !decide.isSuccess ? (
        <ApprovalDecision
          approvalId={approvalId}
          itemName={current.item.name}
          isPending={decide.isPending}
          codeRequired={current.details?.code_required === true}
          onDecide={(decision, code) => decide.mutate({ decision, code })}
        />
      ) : (
        <Notice text={t(`approvals.outcome.${current.status}`)} />
      )}
    </div>
  )
}
