import type { BrainBusinessGraphV2 } from '../../types'
import type { MetaBrainFamily } from './palette'

/** Las tarjetas de resumen, la búsqueda y las fichas de la leyenda. */
type Graph = BrainBusinessGraphV2
type Node = Graph['nodes'][number]

export type InsightFocus = 'all' | 'bets' | 'learned' | 'toConfirm'

export const INSIGHT_FOCUSES: readonly InsightFocus[] = [
  'all',
  'bets',
  'learned',
  'toConfirm',
]

export interface InsightCounts {
  ideas: number
  bets: number
  testing: number
  launched: number
  planned: number
  learned: number
  worked: number
  didNotWork: number
  toConfirm: number
}

export function insightCounts(graph: Graph): InsightCounts {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const bets = graph.sections.active_bets
    .map(id => byId.get(id))
    .filter(Boolean)
  const stage = (value: string) => bets.filter(n => n?.stage === value).length
  return {
    ideas: graph.nodes.length,
    bets: bets.length,
    testing: stage('en_prueba'),
    launched: stage('lanzada'),
    planned: stage('en_plan'),
    learned: graph.sections.learned.length + graph.sections.did_not_work.length,
    worked: graph.sections.learned.length,
    didNotWork: graph.sections.did_not_work.length,
    toConfirm: graph.sections.to_confirm.length,
  }
}

/** Ideas que enfoca una tarjeta; null = todas. */
export function focusIds(
  graph: Graph,
  focus: InsightFocus
): Set<string> | null {
  if (focus === 'bets') return new Set(graph.sections.active_bets)
  if (focus === 'learned')
    return new Set([...graph.sections.learned, ...graph.sections.did_not_work])
  if (focus === 'toConfirm') return new Set(graph.sections.to_confirm)
  return null
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function rank(label: string, query: string): number {
  if (label.startsWith(query)) return 0
  if (label.includes(` ${query}`)) return 1
  return label.includes(query) ? 2 : -1
}

export function searchNodes(nodes: Node[], query: string, limit = 6): Node[] {
  const q = normalizeText(query)
  if (!q) return []
  return nodes
    .map(node => ({ node, score: rank(normalizeText(node.label), q) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => a.score - b.score || b.node.mentions - a.node.mentions)
    .slice(0, limit)
    .map(item => item.node)
}

export function toggleFamily(
  hidden: ReadonlySet<MetaBrainFamily>,
  family: MetaBrainFamily
): Set<MetaBrainFamily> {
  const next = new Set(hidden)
  if (next.has(family)) next.delete(family)
  else next.add(family)
  return next
}
