'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { certaintyOf, SECTION_ORDER, type Certainty } from '../../lib/brain-v2'
import type { BrainBusinessGraphV2, BrainSection } from '../../types'
import { BrainMemoryCard } from './brain-memory-card'

interface Props {
  graph: BrainBusinessGraphV2
  businessId: string
  stopped: boolean
}

type Scope = 'current' | 'history'
const CERTAINTIES: readonly Certainty[] = [
  'verifiedData',
  'youConfirmed',
  'youSaid',
  'observed',
  'deduced',
  'proposed',
  'contradicted',
]

/**
 * «Mi cerebro» por secciones (MLF-002): Apuestas activas, Lo que aprendimos,
 * Lo que no funcionó, Tus correcciones, Pendiente de confirmar, Mi negocio e
 * Historial. Filtros por etapa, certeza y vigente o histórico.
 */
export function BrainSections({ graph, businessId, stopped }: Props) {
  const t = useTranslations('salesAssistant.brain.sections')
  const [scope, setScope] = useState<Scope>('current')
  const [certainty, setCertainty] = useState<Certainty | 'all'>('all')
  const [stage, setStage] = useState<string>('all')
  const byId = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph])
  const stages = useMemo(
    () =>
      [
        ...new Set(
          graph.nodes.map(n => n.stage).filter((s): s is string => !!s)
        ),
      ].sort(),
    [graph]
  )

  const visible = (section: BrainSection) =>
    (graph.sections[section] ?? [])
      .map(id => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .filter(n => certainty === 'all' || certaintyOf(n) === certainty)
      .filter(n => stage === 'all' || n.stage === stage)
  const sections = SECTION_ORDER.filter(s =>
    scope === 'history' ? s === 'history' : s !== 'history'
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="text-sa-text-secondary flex flex-col gap-1">
          {t('filters.scope')}
          <select
            value={scope}
            onChange={e => setScope(e.target.value as Scope)}
            className="bg-sa-surface-elevated border-sa-border-subtle text-sa-text-primary rounded-lg border px-2 py-1 text-sm"
          >
            <option value="current">{t('filters.current')}</option>
            <option value="history">{t('filters.history')}</option>
          </select>
        </label>
        <label className="text-sa-text-secondary flex flex-col gap-1">
          {t('filters.certainty')}
          <select
            value={certainty}
            onChange={e => setCertainty(e.target.value as Certainty | 'all')}
            className="bg-sa-surface-elevated border-sa-border-subtle text-sa-text-primary rounded-lg border px-2 py-1 text-sm"
          >
            <option value="all">{t('filters.all')}</option>
            {CERTAINTIES.map(c => (
              <option key={c} value={c}>
                {t(`certainty.${c}`)}
              </option>
            ))}
          </select>
        </label>
        {stages.length ? (
          <label className="text-sa-text-secondary flex flex-col gap-1">
            {t('filters.stage')}
            <select
              value={stage}
              onChange={e => setStage(e.target.value)}
              className="bg-sa-surface-elevated border-sa-border-subtle text-sa-text-primary rounded-lg border px-2 py-1 text-sm"
            >
              <option value="all">{t('filters.all')}</option>
              {stages.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {sections.map(section => {
        const nodes = visible(section)
        return (
          <section
            key={section}
            aria-labelledby={`brain-section-${section}`}
            className="flex flex-col gap-2"
          >
            <h3
              id={`brain-section-${section}`}
              className="text-sa-text-primary text-sm font-semibold"
            >
              {t(`titles.${section}`)}{' '}
              <span className="text-sa-text-tertiary font-normal">
                ({nodes.length})
              </span>
            </h3>
            {nodes.length ? (
              nodes.map(node => (
                <BrainMemoryCard
                  key={node.id}
                  node={node}
                  graph={graph}
                  businessId={businessId}
                  stopped={stopped}
                />
              ))
            ) : (
              <p className="text-sa-text-tertiary text-xs">
                {t(`empty.${section}`)}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
