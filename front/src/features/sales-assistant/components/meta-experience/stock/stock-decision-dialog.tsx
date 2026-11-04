'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  isStockGoneError,
  isStockInvalidError,
  isStockNegativeError,
  stockErrorKey,
} from '../../../lib/stock-error'
import type { useDecideStockProposal } from '../../../hooks/use-stock'
import {
  STOCK_MOTIVO_MAX,
  type StockCause,
  type StockDecision,
  type StockProposal,
} from '../../../types'
import { MetaConfirmDialog } from '../meta-confirm-dialog'
import {
  causeOptions,
  confirmKind,
  needsCause,
  needsShare,
} from './stock-proposal-rules'
import { StockDecisionBody } from './stock-decision-body'
import {
  shareOf,
  StockSharePicker,
  type StockShareDraft,
  type StockShareOption,
} from './stock-share-picker'

export interface StockDecisionTarget {
  proposal: StockProposal
  decision: StockDecision
}

interface Props {
  target: StockDecisionTarget
  /** La misma propuesta tras el refresco; `undefined` si ya no está pendiente. */
  latest: StockProposal | undefined
  decide: ReturnType<typeof useDecideStockProposal>
  onClose: () => void
  onDone: (proposal: StockProposal) => void
  onGone: () => void
  onReview: (proposal: StockProposal) => void
  /** R15: variantes entre las que se reparte un conteo dudoso. */
  shareOptions?: StockShareOption[]
}

/**
 * Confirmación de una decisión. Solo muestra texto del servidor (`titulo` y
 * efectos): los textos de `detalle` son de terceros y nunca entran aquí. Con
 * `motivo` pasa igual: lo arma el servidor por plantilla, y va en la tarjeta.
 */
export function StockDecisionDialog({
  target,
  latest,
  decide,
  onClose,
  onDone,
  onGone,
  onReview,
  shareOptions = [],
}: Props) {
  const t = useTranslations('metaExperience.stock')
  const { proposal, decision } = target
  const [cause, setCause] = useState<StockCause | null>(null)
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<StockShareDraft>({})
  const sending = useRef(false)
  const approving = decision === 'approve'
  const changed = !!latest && latest.revision !== proposal.revision
  const missingCause = approving && needsCause(proposal) && !cause
  const sharing = approving && needsShare(proposal)
  const total = proposal.tipo === 'conteo' ? proposal.detalle.contado : 0
  const reparto = sharing ? shareOf(draft, shareOptions, total) : null
  const missingShare = sharing && !reparto
  const stuck =
    isStockNegativeError(decide.error) || isStockInvalidError(decide.error)
  const noEffects =
    approving && !(proposal.efectos_si.length && proposal.efectos_no.length)
  const confirm = () => {
    if (changed && latest) return onReview(latest)
    if (sending.current) return
    sending.current = true
    decide.mutate(
      {
        proposalId: proposal.id,
        revision: proposal.revision,
        decision,
        causa: approving && cause ? cause : undefined,
        motivo: !approving && reason.trim() ? reason.trim() : undefined,
        reparto: reparto ?? undefined,
      },
      {
        onSuccess: onDone,
        onError: error => {
          if (isStockGoneError(error)) onGone()
        },
        onSettled: () => {
          sending.current = false
        },
      }
    )
  }
  const label = () => {
    if (changed) return t('dialog.review')
    if (decide.isError) return t('dialog.retry')
    return approving ? t(`confirm.${confirmKind(proposal)}`) : t('reject')
  }
  return (
    <MetaConfirmDialog
      open
      onOpenChange={next => {
        if (!next) onClose()
      }}
      title={t(approving ? 'dialog.approveTitle' : 'dialog.rejectTitle')}
      description={proposal.titulo}
      confirmLabel={label()}
      cancelLabel={t('dialog.back')}
      onConfirm={confirm}
      isPending={decide.isPending}
      confirmDisabled={
        missingCause ||
        missingShare ||
        noEffects ||
        (!latest && !decide.isError)
      }
      hideConfirm={stuck}
    >
      <StockDecisionBody
        proposal={proposal}
        decision={decision}
        causes={causeOptions(proposal)}
        cause={cause}
        onCause={setCause}
        reason={reason}
        onReason={setReason}
        maxReason={STOCK_MOTIVO_MAX}
        share={
          sharing ? (
            <StockSharePicker
              total={total}
              options={shareOptions}
              draft={draft}
              onChange={setDraft}
            />
          ) : null
        }
        hint={
          missingShare
            ? t('dialog.hints.share', { total })
            : missingCause
              ? t('dialog.hints.cause')
              : null
        }
        notice={
          changed ? t('dialog.changed') : !latest ? t('errors.gone') : null
        }
        error={
          decide.isError ? t(stockErrorKey(decide.error, proposal.tipo)) : null
        }
      />
    </MetaConfirmDialog>
  )
}
