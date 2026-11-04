'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useBusinessStore } from '@/store/use-business-store'
import {
  useBrainSnapshotV2,
  useBrainSnapshots,
} from '../../hooks/use-orqa-queries'
import { useSalesAssistantMe } from '../../hooks/use-sales-assistant-me'
import { toBrainGraphModel } from '../../lib/brain-graph-model'
import { asV2, toGraphV1 } from '../../lib/brain-v2'
import { useWebGLSupport } from '../../lib/webgl-support'
import { SalesAssistantClientError } from '../../sdk/sales-assistant-client'
import type { BrainBusinessGraph } from '../../types'
import { BrainDetailPanel } from './brain-detail-panel'
import { BrainDiff } from './brain-diff'
import { BrainSections } from './brain-sections'
import { BrainGraphCanvasLazy } from './brain-graph-canvas.lazy'
import { BrainNodeList } from './brain-node-list'
import { BrainTimeline } from './brain-timeline'

interface Props {
  /** Asistente desactivado: se ve la última foto guardada (por defecto, lo dice `GET /me`). */
  stopped?: boolean
}

function Message({ text }: { text: string }) {
  return (
    <p role="status" className="text-sa-text-secondary text-sm">
      {text}
    </p>
  )
}

function BrainGraph({ graph }: { graph: BrainBusinessGraph }) {
  const t = useTranslations('salesAssistant.brain')
  const webgl = useWebGLSupport()
  const model = useMemo(() => toBrainGraphModel(graph), [graph])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = graph.nodes.find(node => node.id === selectedId) ?? null
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sa-text-tertiary text-xs">
        {t('stats', { nodes: graph.nodes.length, edges: graph.edges.length })}
      </p>
      {webgl ? (
        <BrainGraphCanvasLazy
          model={model}
          selectedId={selectedId}
          onSelect={setSelectedId}
          labels={{
            zoomIn: t('canvas.zoomIn'),
            zoomOut: t('canvas.zoomOut'),
            reset: t('canvas.reset'),
            canvas: t('canvas.label'),
          }}
        />
      ) : (
        <p className="text-sa-text-tertiary text-xs">{t('listHint')}</p>
      )}
      {selected ? (
        <BrainDetailPanel
          node={selected}
          graph={graph}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
      <details open={!webgl} className="flex flex-col gap-2">
        <summary className="text-sa-text-secondary cursor-pointer text-sm font-medium">
          {t('listTitle')}
        </summary>
        <BrainNodeList
          nodes={graph.nodes}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </details>
    </div>
  )
}

type Mode = 'sections' | 'changes' | 'graph'

function BusinessBrain({
  businessId,
  stopped,
}: {
  businessId: string
  stopped: boolean
}) {
  const t = useTranslations('salesAssistant.brain')
  const snapshots = useBrainSnapshots(businessId)
  const [chosen, setChosen] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('sections')
  const latest = snapshots.data?.items[0]?.version ?? null
  const version = chosen ?? latest
  const snapshot = useBrainSnapshotV2(businessId, version)
  const graph = useMemo(
    () => (snapshot.data ? asV2(snapshot.data.graph) : null),
    [snapshot.data]
  )

  if (snapshots.isPending) return <Message text={t('loading')} />
  const noSnapshots =
    snapshots.error instanceof SalesAssistantClientError &&
    snapshots.error.code === 'NOT_FOUND'
  if (noSnapshots || (snapshots.isSuccess && latest === null))
    return <Message text={t('empty')} />
  if (snapshots.isError) return <Message text={t('error')} />
  return (
    <div className="flex flex-col gap-3">
      {stopped ? <Message text={t('stoppedNote')} /> : null}
      <div
        role="tablist"
        aria-label={t('modes.label')}
        className="flex flex-wrap gap-2"
      >
        {(['sections', 'changes', 'graph'] as const).map(value => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={
              mode === value
                ? 'border-sa-purple-400 text-sa-text-primary rounded-full border px-3 py-1 text-sm'
                : 'border-sa-border-subtle text-sa-text-secondary rounded-full border px-3 py-1 text-sm'
            }
          >
            {t(`modes.${value}`)}
          </button>
        ))}
      </div>
      {mode === 'changes' ? (
        <BrainDiff businessId={businessId} items={snapshots.data.items} />
      ) : (
        <>
          <BrainTimeline
            items={snapshots.data.items}
            version={version ?? 0}
            onChange={setChosen}
          />
          {graph ? (
            mode === 'sections' ? (
              <BrainSections
                graph={graph}
                businessId={businessId}
                stopped={stopped}
              />
            ) : (
              <BrainGraph graph={toGraphV1(graph)} />
            )
          ) : (
            <Message text={snapshot.isError ? t('error') : t('loading')} />
          )}
        </>
      )}
    </div>
  )
}

/** «Mi cerebro» (OSF-001): el grafo del negocio activo y cómo va creciendo. */
export function BrainView({ stopped }: Props) {
  const t = useTranslations('salesAssistant.brain')
  const business = useBusinessStore(state => state.selectedBusiness)
  const me = useSalesAssistantMe()
  const isStopped = stopped ?? me.data?.status === 'stopped'
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sa-text-primary text-lg font-semibold">
          {t('title')}
        </h2>
        {business ? (
          <p className="text-sa-text-secondary text-sm">
            {t('subtitle', { business: business.business_name ?? '' })}
          </p>
        ) : null}
      </div>
      {business ? (
        <BusinessBrain businessId={business.business_id} stopped={isStopped} />
      ) : (
        <Message text={t('noBusiness')} />
      )}
    </section>
  )
}
