import type { BrainBusinessGraphV2 } from '../../types'

/**
 * El tiempo del cerebro. No hay un campo «día» ni «iteración»: el día de
 * cada idea sale de sus fechas (created_at → learned_at → valid_from) y el
 * día 1 es el de la primera idea. «Hoy» es la foto más nueva (o la última
 * idea). Una relación aparece cuando existen sus dos extremos.
 */
type Graph = BrainBusinessGraphV2
type Node = Graph['nodes'][number]

export const DAY_MS = 86_400_000

export type MilestoneKind =
  | 'start'
  | 'firstBet'
  | 'firstWin'
  | 'firstLesson'
  | 'firstCorrection'
  | 'peak'

export interface Milestone {
  day: number
  kind: MilestoneKind
  count: number
  nodeId: string | null
}

export interface BrainTimeline {
  /** Medianoche local del día 1 (ms) o null si ninguna idea tiene fecha. */
  start: number | null
  totalDays: number
  distinctDays: number
  nodeDay: Map<string, number>
  /** Día de cada arista, en el mismo orden que `graph.edges`. */
  edgeDay: number[]
  newPerDay: number[]
  cumulative: number[]
  milestones: Milestone[]
}

export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

export function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function nodeTime(
  node: Pick<Node, 'created_at' | 'learned_at' | 'valid_from'>
): number | null {
  return (
    parseTime(node.created_at) ??
    parseTime(node.learned_at) ??
    parseTime(node.valid_from)
  )
}

const WIN_WORDS = new Set([
  'win',
  'won',
  'ganadora',
  'gano',
  'ganó',
  'positive',
])

export function isWin(node: Pick<Node, 'outcome' | 'stage'>): boolean {
  return (
    WIN_WORDS.has((node.outcome ?? '').toLowerCase()) ||
    node.stage === 'ganadora'
  )
}

function dayIndex(start: number, ms: number): number {
  return Math.round((startOfLocalDay(ms) - start) / DAY_MS) + 1
}

function nodeDays(graph: Graph, today: number | null) {
  const times = graph.nodes.map(nodeTime)
  const known = times.filter((t): t is number => t !== null)
  if (!known.length)
    return { start: null, totalDays: 1, days: times.map(() => 1) }
  const start = startOfLocalDay(Math.min(...known))
  const last = Math.max(...known, today ?? -Infinity)
  const totalDays = Math.max(1, dayIndex(start, last))
  const days = times.map(t =>
    t === null ? 1 : Math.min(totalDays, Math.max(1, dayIndex(start, t)))
  )
  return { start, totalDays, days }
}

function firstDay(
  graph: Graph,
  nodeDay: Map<string, number>,
  match: (node: Node) => boolean
): { day: number; id: string } | null {
  let best: { day: number; id: string } | null = null
  for (const node of graph.nodes) {
    if (!match(node)) continue
    const day = nodeDay.get(node.id) ?? 1
    if (!best || day < best.day) best = { day, id: node.id }
  }
  return best
}

const PRIORITY: MilestoneKind[] = [
  'firstWin',
  'firstBet',
  'firstCorrection',
  'firstLesson',
  'peak',
  'start',
]

function milestonesOf(
  graph: Graph,
  nodeDay: Map<string, number>,
  newPerDay: number[]
): Milestone[] {
  const learned = new Set([...(graph.sections.learned ?? [])])
  const corrections = new Set(graph.sections.your_corrections ?? [])
  const found: Milestone[] = [
    { day: 1, kind: 'start', count: newPerDay[0] ?? 0, nodeId: null },
  ]
  const add = (
    kind: MilestoneKind,
    hit: { day: number; id: string } | null
  ) => {
    if (hit) found.push({ kind, day: hit.day, count: 1, nodeId: hit.id })
  }
  add(
    'firstBet',
    firstDay(graph, nodeDay, n => n.family === 'bet')
  )
  const hasVerdicts = graph.nodes.some(n => n.family === 'verdict')
  const winner = hasVerdicts ? 'verdict' : 'bet'
  add(
    'firstWin',
    firstDay(graph, nodeDay, n => n.family === winner && isWin(n))
  )
  add(
    'firstLesson',
    firstDay(
      graph,
      nodeDay,
      n =>
        n.family === 'learned' || (learned.has(n.id) && n.family !== 'verdict')
    )
  )
  add(
    'firstCorrection',
    firstDay(graph, nodeDay, n => corrections.has(n.id))
  )
  let peak = -1
  newPerDay.forEach((count, index) => {
    if (index > 2 && count >= 8 && (peak < 0 || count > newPerDay[peak]))
      peak = index
  })
  if (peak > 0)
    found.push({
      day: peak + 1,
      kind: 'peak',
      count: newPerDay[peak],
      nodeId: null,
    })
  const byDay = new Map<number, Milestone>()
  for (const milestone of found) {
    const current = byDay.get(milestone.day)
    if (
      !current ||
      PRIORITY.indexOf(milestone.kind) < PRIORITY.indexOf(current.kind)
    )
      byDay.set(milestone.day, milestone)
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day)
}

export function deriveTimeline(
  graph: Graph,
  options: { today?: number | null } = {}
): BrainTimeline {
  const { start, totalDays, days } = nodeDays(graph, options.today ?? null)
  const nodeDay = new Map(
    graph.nodes.map((node, index) => [node.id, days[index]])
  )
  const newPerDay = Array.from({ length: totalDays }, () => 0)
  days.forEach(day => (newPerDay[day - 1] += 1))
  const cumulative: number[] = []
  newPerDay.reduce((sum, count, index) => (cumulative[index] = sum + count), 0)
  const edgeDay = graph.edges.map(edge => {
    const ends = Math.max(
      nodeDay.get(edge.source) ?? 1,
      nodeDay.get(edge.target) ?? 1
    )
    const at = parseTime(edge.valid_at)
    const own = start !== null && at !== null ? dayIndex(start, at) : 0
    return Math.min(totalDays, Math.max(ends, own))
  })
  return {
    start,
    totalDays,
    distinctDays: new Set(days).size,
    nodeDay,
    edgeDay,
    newPerDay,
    cumulative,
    milestones: milestonesOf(graph, nodeDay, newPerDay),
  }
}

export function hasTimeline(timeline: BrainTimeline): boolean {
  return timeline.distinctDays >= 2 && timeline.totalDays >= 2
}

export interface DayStats {
  ideas: number
  days: number
  week: number
}

export function statsAt(timeline: BrainTimeline, day: number): DayStats {
  const d = Math.min(timeline.totalDays, Math.max(1, Math.round(day)))
  const weekStart = Math.max(0, d - 7)
  return {
    ideas: timeline.cumulative[d - 1] ?? 0,
    days: d,
    week:
      (timeline.cumulative[d - 1] ?? 0) -
      (weekStart ? timeline.cumulative[weekStart - 1] : 0),
  }
}

/** El hito que se cuenta en un día: el más reciente de los últimos tres días. */
export function captionFor(
  timeline: BrainTimeline,
  day: number
): Milestone | null {
  let found: Milestone | null = null
  for (const milestone of timeline.milestones)
    if (milestone.day <= day && milestone.day > day - 3) found = milestone
  return found
}
