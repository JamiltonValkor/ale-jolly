'use client'

import { useMemo } from 'react'
import { insightCounts } from '../../lib/meta-brain/focus'
import { buildSceneModel } from '../../lib/meta-brain/scene-model'
import { deriveTimeline, hasTimeline } from '../../lib/meta-brain/time'
import type { MetaBrainGraph } from './types'

/** Todo lo que se deriva de una foto: tiempo, escena resuelta y cifras. Una vez por foto. */
export function useMetaBrainModel(graph: MetaBrainGraph, today: number | null) {
  const timeline = useMemo(
    () => deriveTimeline(graph, { today }),
    [graph, today]
  )
  const model = useMemo(
    () => buildSceneModel(graph, timeline),
    [graph, timeline]
  )
  const counts = useMemo(() => insightCounts(graph), [graph])
  return { timeline, model, counts, showTimeline: hasTimeline(timeline) }
}
