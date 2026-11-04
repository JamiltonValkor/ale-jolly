'use client'

import { useMemo, useState } from 'react'
import { MetaBrainScene } from '@/features/sales-assistant/components/meta-brain/meta-brain-scene'
import type {
  ChangesState,
  FeedbackInput,
  FeedbackState,
  MetaBrainGraph,
  MetaBrainMode,
} from '@/features/sales-assistant/components/meta-brain/types'
import {
  FIXTURE_BUSINESS_NAME,
  FIXTURE_TODAY,
  graphAtDay,
  metaBrainFixtureDiff,
  metaBrainFixtureGraph,
  metaBrainFixtureSnapshots,
  stressGraph,
} from '@/features/sales-assistant/lib/meta-brain/fixtures'
import { MetaUiScope } from '@/shared/meta-ui'
import { renderMetaCompanion } from '@/shared/shells/meta-companion'

export type LabState = 'ready' | 'loading' | 'empty' | 'error' | 'stopped'

interface Props {
  state: LabState
  mode: MetaBrainMode
  day: number | null
  stress: boolean
  select: string | null
}

/** «Qué cambió» del laboratorio: el fixture para 13→20; para otras fotos, solo lo nuevo. */
function labChanges(
  graph: MetaBrainGraph,
  from: number,
  to: number
): ChangesState {
  if (from === 13 && to === 20)
    return { from, to, status: 'ready', diff: metaBrainFixtureDiff() }
  const before = new Set(
    graphAtDay(graph, Math.min(from, to) + 7).nodes.map(n => n.id)
  )
  const after = graphAtDay(graph, Math.max(from, to) + 7).nodes
  const added = after.filter(n => !before.has(n.id)) as NonNullable<
    ChangesState['diff']
  >['added']
  return {
    from,
    to,
    status: 'ready',
    diff: {
      from,
      to,
      added,
      removed: [],
      modified: [],
      counts: { added: added.length, removed: 0, modified: 0 },
    },
  }
}

export function MetaBrainLab({ state, mode, day, stress, select }: Props) {
  const full = useMemo(
    () => (stress ? stressGraph(500, 2000) : metaBrainFixtureGraph()),
    [stress]
  )
  const snapshots = useMemo(() => metaBrainFixtureSnapshots(), [])
  const [version, setVersion] = useState(snapshots[0].version)
  const graph = useMemo(
    () =>
      stress || version === snapshots[0].version
        ? full
        : graphAtDay(full, version + 7),
    [full, stress, version, snapshots]
  )
  const [range, setRange] = useState({ from: 13, to: 20 })
  const [feedback, setFeedback] = useState<FeedbackState>({
    nodeId: null,
    status: 'idle',
  })
  const onFeedback = (input: FeedbackInput) => {
    setFeedback({ nodeId: input.nodeId, status: 'pending' })
    window.setTimeout(
      () =>
        setFeedback({
          nodeId: input.nodeId,
          status: state === 'stopped' ? 'queued' : 'sent',
        }),
      700
    )
  }
  const today =
    version === snapshots[0].version
      ? FIXTURE_TODAY
      : Date.parse(snapshots[snapshots[0].version - version].created_at)
  return (
    <MetaUiScope className="min-h-screen">
      <MetaBrainScene
        renderCompanion={renderMetaCompanion}
        businessName={FIXTURE_BUSINESS_NAME}
        status={state === 'stopped' ? 'ready' : state}
        graph={state === 'ready' || state === 'stopped' ? graph : null}
        snapshots={snapshots}
        version={version}
        onVersionChange={setVersion}
        stopped={state === 'stopped'}
        onRetry={() => window.location.reload()}
        feedback={feedback}
        onFeedback={onFeedback}
        changes={labChanges(full, range.from, range.to)}
        onChangesRange={(from, to) => setRange({ from, to })}
        initialMode={mode}
        initialDay={day}
        initialSelectedId={select}
        today={stress ? null : today}
      />
    </MetaUiScope>
  )
}
