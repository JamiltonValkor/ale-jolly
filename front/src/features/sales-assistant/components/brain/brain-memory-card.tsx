'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { SaBadge } from '@/shared/components/sa-badge'
import { SaButton } from '@/shared/components/sa-button'
import { SaCard } from '@/shared/components/sa-card'
import { SaTextarea } from '@/shared/components/sa-textarea'
import { useBrainFeedback } from '../../hooks/use-orqa-mutations'
import { certaintyOf, pathOf } from '../../lib/brain-v2'
import { SalesAssistantClientError } from '../../sdk/sales-assistant-client'
import type { BrainBusinessGraphV2 } from '../../types'

type Node = BrainBusinessGraphV2['nodes'][number]

interface Props {
  node: Node
  graph: BrainBusinessGraphV2
  businessId: string
  stopped: boolean
}

const CERTAINTY_VARIANT = {
  verifiedData: 'success',
  youConfirmed: 'success',
  youSaid: 'info',
  observed: 'default',
  deduced: 'warning',
  proposed: 'warning',
  contradicted: 'default',
} as const

/**
 * Una memoria (MLF-002): la frase, su certeza en lenguaje simple, evidencia,
 * desde cuándo aplica, qué la reemplaza, la etapa de la apuesta y las
 * acciones del dueño. Su ruta (MLF-003) se abre aparte.
 */
export function BrainMemoryCard({ node, graph, businessId, stopped }: Props) {
  const t = useTranslations('salesAssistant.brain.card')
  const format = useFormatter()
  const feedback = useBrainFeedback(businessId)
  const [correcting, setCorrecting] = useState(false)
  const [text, setText] = useState('')
  const [showPath, setShowPath] = useState(false)
  const certainty = certaintyOf(node)
  const replacement = node.superseded_by
    ? graph.nodes.find(n => n.id === node.superseded_by)
    : null
  const unavailable =
    feedback.error instanceof SalesAssistantClientError &&
    feedback.error.code === 'NOT_FOUND'
  const since = node.valid_from ? new Date(node.valid_from) : null
  const path = showPath ? pathOf(graph, node.id) : []
  const send = (action: 'confirm' | 'correct' | 'no_longer_applies') =>
    feedback.mutate(
      { nodeId: node.id, action, ...(action === 'correct' ? { text } : {}) },
      {
        onSuccess: () => {
          setCorrecting(false)
          setText('')
        },
      }
    )

  return (
    <SaCard variant="filled" className="gap-2 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-sa-text-primary min-w-0 flex-1 text-sm font-medium break-words">
          {node.label}
        </p>
        <SaBadge variant={CERTAINTY_VARIANT[certainty]}>
          {t(`certainty.${certainty}`)}
        </SaBadge>
      </div>
      {node.summary && node.summary !== node.label ? (
        <p className="text-sa-text-secondary text-sm whitespace-pre-line">
          {node.summary}
        </p>
      ) : null}
      <div className="text-sa-text-tertiary flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>{node.type_label || node.type}</span>
        {node.stage ? (
          <span>
            {t('stage', {
              stage: t.has(`stages.${node.stage}`)
                ? t(`stages.${node.stage}`)
                : node.stage,
            })}
          </span>
        ) : null}
        {node.confidence ? (
          <span>{t(`confidence.${node.confidence}`)}</span>
        ) : null}
        {node.evidence_count ? (
          <span>{t('evidence', { count: node.evidence_count })}</span>
        ) : null}
        {since && !Number.isNaN(since.getTime()) ? (
          <span>
            {t('since', {
              date: format.dateTime(since, { dateStyle: 'medium' }),
            })}
          </span>
        ) : null}
        {node.scope ? <span>{t('scope', { scope: node.scope })}</span> : null}
      </div>
      {replacement ? (
        <p className="text-sa-text-tertiary text-xs">
          {t('replacedBy', { label: replacement.label })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <SaButton
          variant="ghost"
          size="sm"
          onClick={() => setShowPath(v => !v)}
        >
          {showPath ? t('hidePath') : t('showPath')}
        </SaButton>
        {!unavailable && !feedback.isSuccess ? (
          <>
            <SaButton
              variant="outline"
              size="sm"
              disabled={feedback.isPending}
              onClick={() => send('confirm')}
            >
              {t('actions.confirm')}
            </SaButton>
            <SaButton
              variant="outline"
              size="sm"
              disabled={feedback.isPending}
              onClick={() => setCorrecting(v => !v)}
            >
              {t('actions.correct')}
            </SaButton>
            <SaButton
              variant="outline"
              size="sm"
              disabled={feedback.isPending}
              onClick={() => send('no_longer_applies')}
            >
              {t('actions.noLongerApplies')}
            </SaButton>
          </>
        ) : null}
      </div>
      {path.length ? (
        <ol
          aria-label={t('pathLabel')}
          className="text-sa-text-secondary flex flex-col gap-1 border-l pl-3 text-xs"
        >
          {path.map(step => (
            <li key={`${step.from.id}-${step.relation}-${step.to.id}`}>
              <span className="text-sa-text-primary">{step.from.label}</span>{' '}
              <span className="text-sa-text-tertiary">
                {t.has(`relations.${step.relation}`)
                  ? t(`relations.${step.relation}`)
                  : step.relation}
              </span>{' '}
              <span className="text-sa-text-primary">{step.to.label}</span>
            </li>
          ))}
        </ol>
      ) : showPath ? (
        <p className="text-sa-text-tertiary text-xs">{t('noPath')}</p>
      ) : null}
      {correcting ? (
        <div className="flex flex-col gap-2">
          <SaTextarea
            value={text}
            maxLength={1000}
            placeholder={t('correctPlaceholder')}
            onChange={event => setText(event.target.value)}
          />
          <SaButton
            variant="accent"
            size="sm"
            disabled={feedback.isPending || !text.trim()}
            onClick={() => send('correct')}
          >
            {t('actions.send')}
          </SaButton>
        </div>
      ) : null}
      {feedback.isSuccess ? (
        <p role="status" className="text-sa-text-tertiary text-xs">
          {stopped || feedback.data.status === 'pending'
            ? t('sentLater')
            : t('sent')}
        </p>
      ) : null}
      {feedback.isError && !unavailable ? (
        <p role="alert" className="text-sa-text-secondary text-xs">
          {t('error')}
        </p>
      ) : null}
    </SaCard>
  )
}
