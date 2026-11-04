'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  useDecideStockProposal,
  useStockItems,
  useStockProposals,
} from '../../../hooks/use-stock'
import type { StockDecision, StockProposal } from '../../../types'
import { StockAutonomy } from './stock-autonomy'
import {
  StockDecisionDialog,
  type StockDecisionTarget,
} from './stock-decision-dialog'
import { StockProposalCard } from './stock-proposal-card'
import {
  StockEmpty,
  StockLoading,
  StockReadError,
  StockSectionNotice,
} from './stock-states'
import styles from './stock.module.css'

interface Props {
  businessId: string
  currency: string
  /** `?propuesta=`: tarjeta a la que llevar el foco. */
  proposalId: string | null
}

/** Enlace profundo: lleva a la tarjeta una sola vez, cuando exista. */
function useFocusProposal(proposalId: string | null, found: boolean) {
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (!proposalId || !found || done.current === proposalId) return
    done.current = proposalId
    const card = [
      ...document.querySelectorAll<HTMLElement>('[data-proposal]'),
    ].find(item => item.dataset.proposal === proposalId)
    card?.scrollIntoView({ block: 'start' })
    card?.focus({ preventScroll: true })
  }, [found, proposalId])
}

/** La barrera de la plata: nada cambia hasta que el dueño confirma aquí. */
export function StockApprovalsView({
  businessId,
  currency,
  proposalId,
}: Props) {
  const t = useTranslations('metaExperience.stock')
  const proposals = useStockProposals(businessId)
  // R15: las variantes de un conteo dudoso son las filas que lo esperan.
  const items = useStockItems(businessId)
  const decide = useDecideStockProposal(businessId)
  const [target, setTarget] = useState<StockDecisionTarget | null>(null)
  const [resolved, setResolved] = useState<StockProposal[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const { refetch } = proposals
  const refresh = useCallback(() => void refetch(), [refetch])
  const pending = (proposals.data ?? []).filter(
    item => !resolved.some(done => done.id === item.id)
  )
  const shown = [...resolved, ...pending]
  const found = shown.some(item => item.id === proposalId)
  useFocusProposal(proposalId, found)
  const unknownLink = proposalId !== null && !!proposals.data && !found
  const close = () => {
    decide.reset()
    decide.clearAttempts()
    setTarget(null)
  }
  const open = (proposal: StockProposal, decision: StockDecision) => {
    decide.reset()
    setNotice(null)
    setTarget({ proposal, decision })
  }
  if (proposals.isPending) return <StockLoading />
  if (!proposals.data) return <StockReadError onRetry={refresh} />
  const latest = pending.find(item => item.id === target?.proposal.id)
  return (
    <div className={styles.cards}>
      {notice ? (
        <p role="status" aria-live="polite" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {unknownLink ? (
        <p role="status" className={styles.notice}>
          {t('unknownProposal')}
        </p>
      ) : null}
      {proposals.isError ? (
        <StockSectionNotice section="proposals" onRetry={refresh} />
      ) : null}
      {shown.length === 0 ? <StockEmpty kind="proposals" /> : null}
      {shown.map(proposal => (
        <StockProposalCard
          key={proposal.id}
          proposal={proposal}
          currency={currency}
          resolved={resolved.includes(proposal)}
          onDecide={open}
          onRefresh={refresh}
        />
      ))}
      <StockAutonomy businessId={businessId} />
      {target ? (
        <StockDecisionDialog
          key={`${target.proposal.id}:${target.proposal.revision}:${target.decision}`}
          target={target}
          latest={latest}
          decide={decide}
          onClose={close}
          shareOptions={(items.data?.items ?? [])
            .filter(item => item.propuesta_id === target.proposal.id)
            .map(item => ({
              variante_id: item.variante_id,
              nombre: item.variante,
            }))}
          onDone={proposal => {
            // La tarjeta sigue mostrando lo que la dueña aprobó: tras aprobar,
            // el servidor ya devuelve lo esperado igual a lo contado.
            const shown = { ...target.proposal, estado: proposal.estado }
            setResolved(current => [shown, ...current])
            close()
          }}
          onGone={() => {
            close()
            setNotice(t('errors.gone'))
          }}
          onReview={proposal => {
            decide.reset()
            setTarget({ proposal, decision: target.decision })
          }}
        />
      ) : null}
    </div>
  )
}
