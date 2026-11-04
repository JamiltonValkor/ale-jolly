'use client'

import { useId, useState, type CSSProperties } from 'react'
import { PauseCircle, X } from '@phosphor-icons/react'
import { useReducedMotion } from 'motion/react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  focusIds as focusIdsOf,
  type InsightFocus,
} from '../../lib/meta-brain/focus'
import { statsAt } from '../../lib/meta-brain/time'
import { SnapshotPicker } from './snapshot-picker'
import {
  BrainEmpty,
  BrainError,
  BrainLoading,
  BrainNoBusiness,
} from './brain-states'
import { ChangesView } from './changes-view'
import { GraphStage } from './graph-stage'
import { InsightTiles } from './insight-tiles'
import { ModeTabs, MODES, panelId, tabId } from './mode-tabs'
import { SectionsView } from './sections-view'
import type {
  MetaBrainGraph,
  MetaBrainMode,
  MetaBrainSceneProps,
} from './types'
import { useGrowthPlayback } from './use-growth-playback'
import { useMetaBrainModel } from './use-meta-brain-model'
import styles from './meta-brain.module.css'

const rise = (step: number) =>
  ({ animationDelay: `${step * 70}ms` }) as CSSProperties

function StoppedNotice({ snapshots }: Pick<MetaBrainSceneProps, 'snapshots'>) {
  const t = useTranslations('metaBrain')
  const format = useFormatter()
  const latest = snapshots[0]
  const date = latest
    ? format.dateTime(new Date(latest.created_at), {
        day: 'numeric',
        month: 'long',
      })
    : '—'
  return (
    <p className={styles.notice} role="status">
      <PauseCircle
        className={styles.noticeIcon}
        size={18}
        weight="light"
        aria-hidden="true"
      />
      {t('stopped', { date })}
    </p>
  )
}

function useDay(
  graph: MetaBrainGraph,
  total: number,
  initial: number | null | undefined
) {
  const clamp = (value: number) =>
    Math.min(total, Math.max(1, Math.round(value)))
  const [state, setState] = useState({ graph, day: clamp(initial ?? total) })
  if (state.graph !== graph) setState({ graph, day: total })
  return [
    state.graph === graph ? state.day : total,
    (day: number) => setState({ graph, day: clamp(day) }),
  ] as const
}

function FocusChip({
  focus,
  onClear,
}: {
  focus: InsightFocus
  onClear: () => void
}) {
  const t = useTranslations('metaBrain')
  if (focus === 'all') return null
  const name =
    focus === 'bets'
      ? t('tiles.bets.title')
      : focus === 'learned'
        ? t('tiles.learned.title')
        : t('tiles.toConfirm.title')
  return (
    <span className={styles.focusChip} role="status">
      {t('tiles.focused', { name })}
      <button type="button" className={styles.chipButton} onClick={onClear}>
        <X size={11} weight="bold" aria-hidden="true" />
        {t('tiles.clear')}
      </button>
    </span>
  )
}

function ReadyScene(props: MetaBrainSceneProps & { graph: MetaBrainGraph }) {
  const {
    graph,
    businessName,
    snapshots,
    version,
    stopped,
    feedback,
    onFeedback,
    className,
  } = props
  const reduced = useReducedMotion() ?? false
  const idBase = useId()
  const { timeline, model, counts, showTimeline } = useMetaBrainModel(
    graph,
    props.today ?? null
  )
  const [mode, setMode] = useState<MetaBrainMode>(props.initialMode ?? 'graph')
  const [focus, setFocus] = useState<InsightFocus>('all')
  const [selectedId, setSelectedId] = useState<string | null>(
    props.initialSelectedId ?? null
  )
  const [day, setDay] = useDay(
    graph,
    timeline.totalDays,
    showTimeline ? props.initialDay : null
  )
  const playback = useGrowthPlayback({
    total: timeline.totalDays,
    day,
    onDay: setDay,
  })
  const viewDay = mode === 'graph' && showTimeline ? day : timeline.totalDays
  const focusSet = focusIdsOf(graph, focus)
  const shared = { selectedId, onSelect: setSelectedId, feedback, onFeedback }
  return (
    <div className={cn(styles.scene, className)}>
      {stopped ? <StoppedNotice snapshots={snapshots} /> : null}
      <div className={styles.rise} style={rise(1)}>
        <InsightTiles
          counts={counts}
          week={statsAt(timeline, timeline.totalDays).week}
          focus={focus}
          onFocus={setFocus}
          reduced={reduced}
        />
      </div>
      <div className={cn(styles.modeRow, styles.rise)} style={rise(2)}>
        <ModeTabs mode={mode} onChange={setMode} idBase={idBase} />
        <FocusChip focus={focus} onClear={() => setFocus('all')} />
        <SnapshotPicker
          className={styles.pushRight}
          snapshots={snapshots}
          version={version}
          onVersionChange={props.onVersionChange}
        />
      </div>
      {MODES.map(value => (
        <div
          key={value}
          role="tabpanel"
          id={panelId(idBase, value)}
          aria-labelledby={tabId(idBase, value)}
          hidden={mode !== value}
          className={cn(styles.panel, styles.rise)}
          style={rise(3)}
        >
          {mode === value && value === 'graph' ? (
            <GraphStage
              graph={graph}
              model={model}
              timeline={timeline}
              showTimeline={showTimeline}
              day={viewDay}
              onDayChange={next => {
                playback.stop()
                setDay(next)
              }}
              playing={playback.playing}
              onPlayToggle={playback.toggle}
              focusIds={focusSet}
              reduced={reduced}
              businessName={businessName}
              {...shared}
            />
          ) : null}
          {mode === value && value === 'sections' ? (
            <SectionsView
              graph={graph}
              timeline={timeline}
              focus={focus}
              {...shared}
            />
          ) : null}
          {mode === value && value === 'changes' ? (
            <ChangesView
              snapshots={snapshots}
              changes={props.changes}
              onRange={props.onChangesRange}
              onRetry={props.onChangesRetry}
              graph={graph}
              timeline={timeline}
              {...shared}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * «Mi cerebro» del Meta Assistant (vista presentacional): lo que el agente
 * sabe del negocio, cómo crece día a día y las apuestas del loop. Recibe
 * datos planos; el contenedor `MetaBrainView` los trae del servicio.
 */
export function MetaBrainScene(props: MetaBrainSceneProps) {
  const { status, graph, businessName, className } = props
  if (status === 'noBusiness') return <BrainNoBusiness className={className} />
  if (status === 'loading')
    return <BrainLoading businessName={businessName} className={className} />
  // Sin cerebro todavía, solo el estado: el marco ya dice dónde estás.
  if (status === 'error' || status === 'empty' || !graph)
    return (
      <div className={cn(styles.scene, className)}>
        {status === 'error' ? (
          <BrainError onRetry={props.onRetry} />
        ) : (
          <BrainEmpty
            businessName={businessName}
            renderCompanion={props.renderCompanion}
          />
        )}
      </div>
    )
  return <ReadyScene {...props} graph={graph} />
}
