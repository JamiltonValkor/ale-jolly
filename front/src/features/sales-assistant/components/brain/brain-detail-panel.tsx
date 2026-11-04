'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { X } from '@phosphor-icons/react'
import { SaBadge } from '@/shared/components/sa-badge'
import { SaButton } from '@/shared/components/sa-button'
import { SaCard } from '@/shared/components/sa-card'
import type { BrainBusinessGraph, BrainNode } from '../../types'

interface Props {
  node: BrainNode
  graph: BrainBusinessGraph
  onClose: () => void
}

const STATE_VARIANT = {
  observed: 'default',
  proposed: 'warning',
  validated: 'success',
  superseded: 'default',
} as const

function relationsOf(node: BrainNode, graph: BrainBusinessGraph) {
  const labels = new Map(graph.nodes.map(item => [item.id, item.label]))
  // Solo hechos vigentes: lo que el dueño corrigió queda invalidado (laboratorio L1-04).
  return graph.edges
    .filter(edge => edge.invalid_at === null)
    .filter(edge => edge.source === node.id || edge.target === node.id)
    .slice(0, 12)
    .map(edge => ({
      key: `${edge.source}-${edge.type}-${edge.target}`,
      text:
        edge.fact ||
        `${labels.get(edge.source) ?? ''} · ${edge.type} · ${labels.get(edge.target) ?? ''}`,
    }))
}

/** Detalle de una idea del cerebro. Todo es texto: nunca se arma un enlace con sus datos. */
export function BrainDetailPanel({ node, graph, onClose }: Props) {
  const t = useTranslations('salesAssistant.brain')
  const format = useFormatter()
  const relations = relationsOf(node, graph)
  return (
    <SaCard variant="filled" className="gap-3 p-4" aria-live="polite">
      <div className="flex items-start gap-2">
        <h3 className="text-sa-text-primary flex-1 text-base font-semibold break-words">
          {node.label}
        </h3>
        <SaButton
          size="icon"
          variant="ghost"
          aria-label={t('detail.close')}
          onClick={onClose}
        >
          <X />
        </SaButton>
      </div>
      <div className="flex flex-wrap gap-2">
        <SaBadge size="sm" variant="info">
          {t(`family.${node.family}`)}
        </SaBadge>
        <SaBadge size="sm" variant={STATE_VARIANT[node.state]}>
          {t(`state.${node.state}`)}
        </SaBadge>
        <span className="text-sa-text-tertiary text-xs">
          {t('detail.mentions', { count: node.mentions })}
        </span>
      </div>
      <p className="text-sa-text-secondary text-sm">
        {node.summary || t('detail.noSummary')}
      </p>
      {node.created_at && !Number.isNaN(Date.parse(node.created_at)) ? (
        <p className="text-sa-text-tertiary text-xs">
          {t('detail.since', {
            date: format.dateTime(new Date(node.created_at), {
              dateStyle: 'medium',
            }),
          })}
        </p>
      ) : null}
      {relations.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-sa-text-secondary text-xs font-medium">
            {t('detail.relations')}
          </p>
          <ul className="text-sa-text-secondary flex flex-col gap-1 text-xs">
            {relations.map(relation => (
              <li key={relation.key}>{relation.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </SaCard>
  )
}
