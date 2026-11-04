'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SaButton } from '@/shared/components/sa-button'
import { SaConfirmModal } from '@/shared/components/sa-confirm-modal'
import { SaInput } from '@/shared/components/sa-input'
import { useApprovalCode } from '../../hooks/use-orqa-mutations'
import { approvalErrorKey } from '../../lib/approval-error'

type Decision = 'approve' | 'reject'
const MAX_CODES = 3

interface Props {
  approvalId?: string
  itemName: string
  isPending: boolean
  /** Acción de gasto (MLB-013): aprobar pide un código de un solo uso. */
  codeRequired?: boolean
  /** Textos propios del encendido del agente (AAF-003): botón y confirmación sin código. */
  copyKey?: 'agentActivation'
  /** Etiqueta del botón de aprobar (p. ej. «Encender y subir mi presupuesto a X»). */
  approveLabel?: string
  /** Descripción de la confirmación de aprobar, ya traducida. */
  approveDescription?: string
  onDecide: (decision: Decision, code?: string) => void
}

/**
 * Aprobar o rechazar, siempre con confirmación. Una sola decisión por
 * aprobación. En una acción de gasto, aprobar pide antes el código de un solo
 * uso (MLF-006): en el MVP es simulado y se muestra aquí, como si llegara por
 * mensaje; vence en 5 minutos, 3 intentos por código y hasta 3 códigos.
 */
export function ApprovalDecision({
  approvalId,
  itemName,
  isPending,
  codeRequired = false,
  copyKey,
  approveLabel,
  approveDescription,
  onDecide,
}: Props) {
  const t = useTranslations('salesAssistant.approvals')
  const tRoot = useTranslations('salesAssistant')
  const [confirming, setConfirming] = useState<Decision | null>(null)
  const [codeStep, setCodeStep] = useState(false)
  const [typed, setTyped] = useState('')
  const [issued, setIssued] = useState(0)
  const codeRequest = useApprovalCode(approvalId ?? '')
  const close = () => setConfirming(null)
  const copy = confirmCopy(t, { confirming, codeRequired, copyKey, itemName })
  const approveText = approveLabel ?? copy.approve

  const askCode = () => {
    setTyped('')
    codeRequest.mutate(undefined, { onSuccess: () => setIssued(n => n + 1) })
  }
  const startApprove = () => {
    if (!codeRequired) {
      setConfirming('approve')
      return
    }
    setCodeStep(true)
    if (!codeRequest.data) askCode()
  }

  return (
    <div className="flex flex-col gap-4">
      {codeStep ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sa-text-primary text-sm font-medium">
            {t('code.title')}
          </p>
          {codeRequest.data?.code ? (
            <p className="text-sa-text-secondary text-sm">
              {t('code.simulated')}{' '}
              <span className="text-sa-text-primary font-mono text-base tracking-widest">
                {codeRequest.data.code}
              </span>
            </p>
          ) : null}
          {codeRequest.isError ? (
            <p role="alert" className="text-sa-text-secondary text-sm">
              {tRoot(approvalErrorKey(codeRequest.error))}
            </p>
          ) : null}
          <SaInput
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label={t('code.label')}
            placeholder="000000"
            value={typed}
            onChange={event =>
              setTyped(event.target.value.replace(/\D/g, '').slice(0, 6))
            }
          />
          <div className="flex flex-wrap gap-3">
            <SaButton
              variant="accent"
              disabled={isPending || typed.length !== 6}
              onClick={() => setConfirming('approve')}
            >
              {t('approve')}
            </SaButton>
            <SaButton
              variant="outline"
              disabled={
                isPending || codeRequest.isPending || issued >= MAX_CODES
              }
              onClick={askCode}
            >
              {t('code.another', { left: Math.max(MAX_CODES - issued, 0) })}
            </SaButton>
          </div>
          <p className="text-sa-text-tertiary text-xs">{t('code.rules')}</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <SaButton
            variant="accent"
            disabled={isPending}
            onClick={startApprove}
          >
            {approveText}
          </SaButton>
          <SaButton
            variant="outline"
            disabled={isPending}
            onClick={() => setConfirming('reject')}
          >
            {t('reject')}
          </SaButton>
        </div>
      )}
      <SaConfirmModal
        open={confirming !== null}
        onOpenChange={open => {
          if (!open) close()
        }}
        title={copy.title}
        description={
          confirming === 'approve' && approveDescription
            ? approveDescription
            : copy.description
        }
        confirmLabel={confirming === 'reject' ? t('reject') : approveText}
        cancelLabel={t('cancel')}
        tone={confirming === 'reject' ? 'destructive' : 'default'}
        isLoading={isPending}
        onConfirm={() => {
          if (confirming === 'approve' && codeRequired)
            onDecide('approve', typed)
          else if (confirming) onDecide(confirming)
          close()
        }}
        onCancel={close}
      />
    </div>
  )
}

type Translate = ReturnType<typeof useTranslations<'salesAssistant.approvals'>>

/** Títulos y descripciones de la confirmación según el tipo de aprobación. */
function confirmCopy(
  t: Translate,
  {
    confirming,
    codeRequired,
    copyKey,
    itemName,
  }: {
    confirming: Decision | null
    codeRequired: boolean
    copyKey?: 'agentActivation'
    itemName: string
  }
) {
  if (copyKey === 'agentActivation') {
    const base = confirming === 'reject' ? 'confirmReject' : 'confirmApprove'
    return {
      title: t(`agentActivation.${base}.title`),
      description: t(`agentActivation.${base}.description`),
      approve: t('agentActivation.approve'),
    }
  }
  const base =
    confirming === 'reject'
      ? 'confirmReject'
      : codeRequired
        ? 'confirmSpend'
        : 'confirmApprove'
  return {
    title: t(`${base}.title`),
    description: t(`${base}.description`, { name: itemName }),
    approve: t('approve'),
  }
}
