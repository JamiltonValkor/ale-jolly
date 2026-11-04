'use client'

import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import {
  CornersOut,
  Graph,
  ListBullets,
  Minus,
  Plus,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  META_BRAIN_FAMILIES,
  type MetaBrainFamily,
} from '../../lib/meta-brain/palette'
import type { SceneModel } from '../../lib/meta-brain/scene-model'
import type { BrainTimeline } from '../../lib/meta-brain/time'
import { toggleFamily } from '../../lib/meta-brain/focus'
import { compactLabel } from '../../lib/brain-graph-model'
import { Constellation, type ConstellationApi } from './constellation'
import { FamilyLegend } from './family-legend'
import { GrowthTimeline } from './growth-timeline'
import { NodeDetail } from './node-detail'
import { NodeList } from './node-list'
import { NodeSearch } from './node-search'
import { ReadingGuide } from './reading-guide'
import type { FeedbackInput, FeedbackState, MetaBrainGraph } from './types'
import styles from './meta-brain.module.css'

interface Props {
  graph: MetaBrainGraph
  model: SceneModel
  timeline: BrainTimeline
  showTimeline: boolean
  day: number
  onDayChange: (day: number) => void
  playing: boolean
  onPlayToggle: () => void
  focusIds: Set<string> | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  feedback: FeedbackState
  onFeedback: (input: FeedbackInput) => void
  reduced: boolean
  businessName: string
  className?: string
}

const NARROW = '(max-width: 760px)'
function useNarrow(): boolean {
  return useSyncExternalStore(
    notify => {
      const query = window.matchMedia?.(NARROW)
      query?.addEventListener('change', notify)
      return () => query?.removeEventListener('change', notify)
    },
    () => window.matchMedia?.(NARROW).matches ?? false,
    () => false
  )
}

function ZoomControls({
  apiRef,
}: {
  apiRef: RefObject<ConstellationApi | null>
}) {
  const t = useTranslations('metaBrain.graph')
  return (
    <div role="group" aria-label={t('controls')} className={styles.zoom}>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={t('zoomIn')}
        title={t('zoomIn')}
        onClick={() => apiRef.current?.zoomIn()}
      >
        <Plus size={16} weight="light" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={t('zoomOut')}
        title={t('zoomOut')}
        onClick={() => apiRef.current?.zoomOut()}
      >
        <Minus size={16} weight="light" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={t('reset')}
        title={t('reset')}
        onClick={() => apiRef.current?.reset()}
      >
        <CornersOut size={16} weight="light" aria-hidden="true" />
      </button>
    </div>
  )
}

function familyCounts(model: SceneModel, day: number) {
  const counts = new Map<MetaBrainFamily, number>()
  for (const node of model.nodes)
    if (node.day <= day)
      counts.set(node.family, (counts.get(node.family) ?? 0) + 1)
  return META_BRAIN_FAMILIES.filter(f => counts.has(f)).map(family => ({
    family,
    count: counts.get(family) ?? 0,
  }))
}

/**
 * El escenario del modo «Grafo»: búsqueda y ayuda arriba, la constelación (o
 * su lista) con la leyenda y el zoom, el detalle a la derecha y la línea de
 * tiempo abajo.
 */
export function GraphStage(props: Props) {
  const {
    graph,
    model,
    timeline,
    showTimeline,
    day,
    focusIds,
    selectedId,
    onSelect,
    reduced,
  } = props
  const t = useTranslations('metaBrain.graph')
  const narrow = useNarrow()
  const apiRef = useRef<ConstellationApi | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<ReadonlySet<MetaBrainFamily>>(new Set())
  const [listView, setListView] = useState(false)
  const [engaged, setEngaged] = useState(false)
  const [fly, setFly] = useState<{ id: string; seq: number } | null>(null)
  const counts = useMemo(() => familyCounts(model, day), [model, day])
  const highlight = useMemo(() => {
    const index = model.order.find(i => model.nodes[i].day === day)
    return index === undefined
      ? null
      : compactLabel(model.nodes[index].label, 52)
  }, [model, day])
  const known = useMemo(
    () => graph.nodes.filter((_, i) => model.nodes[i].day <= day),
    [graph, model, day]
  )
  const selectedIndex = selectedId ? model.index.get(selectedId) : undefined
  const selected =
    selectedIndex !== undefined ? model.nodes[selectedIndex] : null
  const showDetail =
    !!selected && selected.day <= day && !hidden.has(selected.family)
  const visibleCount = model.nodes.filter(
    n =>
      n.day <= day && !hidden.has(n.family) && (!focusIds || focusIds.has(n.id))
  ).length
  const pick = (id: string) => {
    onSelect(id)
    setFly(current => ({ id, seq: (current?.seq ?? 0) + 1 }))
  }
  const close = () => {
    onSelect(null)
    bodyRef.current?.querySelector<HTMLElement>('[role="application"]')?.focus()
  }
  const legend = {
    counts,
    hidden,
    onToggle: (f: MetaBrainFamily) => setHidden(h => toggleFamily(h, f)),
    onShowAll: () => setHidden(new Set()),
  }
  return (
    <div className={cn(styles.stage, props.className)}>
      <div className={styles.stageHead}>
        <NodeSearch nodes={known} onPick={pick} />
        <div className={styles.stageTools}>
          <ReadingGuide />
          <button
            type="button"
            className={styles.ghostButton}
            aria-pressed={listView}
            aria-label={listView ? t('canvas') : t('list')}
            onClick={() => setListView(v => !v)}
          >
            {listView ? (
              <Graph size={16} weight="light" aria-hidden="true" />
            ) : (
              <ListBullets size={16} weight="light" aria-hidden="true" />
            )}
            <span className={styles.ghostLabel}>
              {listView ? t('canvas') : t('list')}
            </span>
          </button>
        </div>
      </div>
      <FamilyLegend {...legend} variant="chips" />
      <div ref={bodyRef} className={styles.stageBody}>
        {listView ? (
          <div
            className={styles.listView}
            style={showDetail && !narrow ? { paddingRight: 410 } : undefined}
          >
            <NodeList
              model={model}
              day={day}
              hidden={hidden}
              focusIds={focusIds}
              selectedId={selectedId}
              onSelect={id => onSelect(id)}
            />
          </div>
        ) : (
          <>
            <Constellation
              model={model}
              graph={graph}
              day={day}
              hidden={hidden}
              focusIds={focusIds}
              selectedId={selectedId}
              onSelect={onSelect}
              insetLeft={narrow ? 0 : 190}
              insetRight={showDetail && !narrow ? 404 : 0}
              flyTo={fly}
              reduced={reduced}
              apiRef={apiRef}
              onEngage={() => setEngaged(true)}
            />
            <FamilyLegend {...legend} variant="rail" />
            {!showDetail ? <ZoomControls apiRef={apiRef} /> : null}
            {!engaged && !selectedId ? (
              <p className={styles.stageHint}>{t('hint')}</p>
            ) : null}
          </>
        )}
        {visibleCount === 0 ? (
          <div className={styles.emptyOverlay} role="status">
            {t('nothingVisible')}
            <button
              type="button"
              className={styles.chipButton}
              onClick={() => setHidden(new Set())}
            >
              {t('showAll')}
            </button>
          </div>
        ) : null}
        {showDetail && selected ? (
          <div className={styles.drawer}>
            <NodeDetail
              node={graph.nodes[selectedIndex ?? 0]}
              graph={graph}
              timeline={timeline}
              feedback={props.feedback}
              onFeedback={props.onFeedback}
              onClose={close}
              onNavigate={pick}
            />
          </div>
        ) : null}
      </div>
      {showTimeline ? (
        <GrowthTimeline
          timeline={timeline}
          day={day}
          onDayChange={props.onDayChange}
          playing={props.playing}
          onPlayToggle={props.onPlayToggle}
          businessName={props.businessName}
          dayHighlight={highlight}
        />
      ) : null}
    </div>
  )
}
