import type { BrainBusinessGraphV2 } from '../../types'
import { controlPoint } from './geometry'
import { layoutConstellation, type Bounds } from './layout'
import {
  FAMILY_COLOR,
  familyOf,
  isStandout,
  type MetaBrainFamily,
  type Outcome,
} from './palette'
import { isWin, nodeTime, type BrainTimeline } from './time'

/**
 * La escena que pinta la constelación: posiciones resueltas, tamaño por
 * menciones y evidencia, color por familia, día de llegada, importancia
 * (para etiquetas y teclado) y aristas curvas con su punto de control.
 */
type Graph = BrainBusinessGraphV2
type Node = Graph['nodes'][number]

export interface SceneNode {
  id: string
  label: string
  family: MetaBrainFamily
  color: string
  x: number
  y: number
  r: number
  day: number
  importance: number
  outcome: Outcome | null
  superseded: boolean
}

export interface SceneEdge {
  source: number
  target: number
  type: string
  day: number
  cx: number
  cy: number
  /** Para que los pulsos no salgan todos a la vez. */
  phase: number
}

export interface SceneModel {
  nodes: SceneNode[]
  edges: SceneEdge[]
  index: Map<string, number>
  neighbors: number[][]
  /** Índices de mayor a menor importancia. */
  order: number[]
  bounds: Bounds
  xs: Float32Array
  ys: Float32Array
  rs: Float32Array
}

const LOSS = new Set(['loss', 'lost', 'perdedora', 'negative'])

function outcomeOf(node: Node): Outcome | null {
  if (node.family !== 'verdict' && node.family !== 'bet') return null
  if (isWin(node)) return 'win'
  if (
    LOSS.has((node.outcome ?? '').toLowerCase()) ||
    node.stage === 'perdedora'
  )
    return 'loss'
  return 'open'
}

function radiusOf(node: Node, family: MetaBrainFamily): number {
  const weight = node.mentions + 2 * (node.evidence_count ?? 0)
  const base = 3 + Math.sqrt(weight) * 1.35
  const standout = isStandout(family) ? Math.max(base, 6) : base
  const r = node.state === 'superseded' ? standout * 0.7 : standout
  return Math.min(13, Math.max(3, r))
}

function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  return h >>> 0
}

function edgesOf(
  graph: Graph,
  index: Map<string, number>,
  timeline: BrainTimeline
) {
  const edges: Array<{
    source: number
    target: number
    type: string
    day: number
    key: string
  }> = []
  graph.edges.forEach((edge, i) => {
    const source = index.get(edge.source)
    const target = index.get(edge.target)
    if (source === undefined || target === undefined || source === target)
      return
    if (edge.invalid_at !== null) return
    edges.push({
      source,
      target,
      type: edge.type,
      day: timeline.edgeDay[i] ?? 1,
      key: `${edge.source}>${edge.target}`,
    })
  })
  return edges
}

export function buildSceneModel(
  graph: Graph,
  timeline: BrainTimeline
): SceneModel {
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]))
  const families = graph.nodes.map(node => familyOf(node.family))
  const radii = graph.nodes.map((node, i) => radiusOf(node, families[i]))
  const raw = edgesOf(graph, index, timeline)
  const neighbors: number[][] = graph.nodes.map(() => [])
  raw.forEach(e => {
    neighbors[e.source].push(e.target)
    neighbors[e.target].push(e.source)
  })
  const layout = layoutConstellation(
    graph.nodes.map((node, i) => ({
      id: node.id,
      family: families[i],
      // Las apuestas y los veredictos llevan anillo: piden más aire.
      r: radii[i] * (isStandout(families[i]) ? 1.6 : 1),
      age: nodeTime(node) ?? 0,
    })),
    raw
  )
  const nodes: SceneNode[] = graph.nodes.map((node, i) => ({
    id: node.id,
    label: node.label,
    family: families[i],
    color: FAMILY_COLOR[families[i]],
    x: layout.x[i],
    y: layout.y[i],
    r: radii[i],
    day: timeline.nodeDay.get(node.id) ?? 1,
    importance:
      node.mentions +
      2 * (node.evidence_count ?? 0) +
      neighbors[i].length * 0.8 +
      (isStandout(families[i]) ? 8 : 0),
    outcome: outcomeOf(node),
    superseded: node.state === 'superseded',
  }))
  const edges: SceneEdge[] = raw.map(e => {
    const a = nodes[e.source]
    const b = nodes[e.target]
    const h = hash(e.key)
    const [cx, cy] = controlPoint(
      a.x,
      a.y,
      b.x,
      b.y,
      0.12 + (h % 7) / 100,
      h % 2 ? 1 : -1
    )
    return {
      source: e.source,
      target: e.target,
      type: e.type,
      day: e.day,
      cx,
      cy,
      phase: (h % 1000) / 1000,
    }
  })
  const order = nodes
    .map((_, i) => i)
    .sort((a, b) => nodes[b].importance - nodes[a].importance || a - b)
  return {
    nodes,
    edges,
    index,
    neighbors,
    order,
    bounds: layout.bounds,
    xs: layout.x,
    ys: layout.y,
    rs: Float32Array.from(radii),
  }
}

export function visibilityMask(
  model: SceneModel,
  view: { day: number; hidden: ReadonlySet<string> }
): boolean[] {
  return model.nodes.map(
    node => node.day <= view.day && !view.hidden.has(node.family)
  )
}
