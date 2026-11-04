import type {
  BrainBusinessGraph,
  BrainBusinessGraphV2,
  BrainSection,
  BrainSnapshotAny,
} from '../types'

/**
 * Lectura de «Mi cerebro» v2 (MLF-002/003): certeza en lenguaje simple,
 * secciones y la ruta de una conclusión. Funciona con una foto v1 (servicio
 * o cerebro viejos): sin secciones, todo cae en «Mi negocio».
 */
export type Certainty =
  | 'verifiedData'
  | 'youConfirmed'
  | 'youSaid'
  | 'observed'
  | 'deduced'
  | 'proposed'
  | 'contradicted'

type AnyNode = BrainBusinessGraphV2['nodes'][number]

export function certaintyOf(
  node: Pick<AnyNode, 'state' | 'provenance'> & { verification?: string }
): Certainty {
  const v = node.verification ?? ''
  if (node.state === 'superseded' || v === 'CONTRADICTED' || v === 'RETRACTED')
    return 'contradicted'
  if (v === 'HUMAN_VALIDATED' || node.provenance === 'owner_decided')
    return 'youConfirmed'
  if (node.provenance === 'owner_said' || v === 'SELF_REPORTED')
    return 'youSaid'
  if (
    v === 'SYSTEM_VERIFIED' ||
    node.provenance === 'platform' ||
    node.provenance === 'saleads_seed'
  )
    return 'verifiedData'
  if (v === 'PROPOSED') return 'proposed'
  if (
    v === 'INFERRED' ||
    node.provenance === 'inferred' ||
    node.provenance === 'inferred_from_platform'
  )
    return 'deduced'
  return node.state === 'proposed' ? 'proposed' : 'observed'
}

export function isV2(
  snapshot: BrainSnapshotAny
): snapshot is BrainSnapshotAny & { graph: BrainBusinessGraphV2 } {
  return 'sections' in snapshot.graph
}

/** Grafo v2 (o v1 elevado: sin atributos del loop, todo en «Mi negocio»). */
export function asV2(
  graph: BrainBusinessGraph | BrainBusinessGraphV2
): BrainBusinessGraphV2 {
  if ('sections' in graph) return graph
  const nodes = graph.nodes.map(n => ({
    ...n,
    type_label: n.type,
    stage: null,
    confidence: null,
    verification: '',
    valid_from: null,
    learned_at: null,
    superseded_by: null,
    scope: null,
    evidence_count: null,
    outcome: null,
  }))
  return {
    ...graph,
    nodes,
    sections: {
      my_business: nodes.map(n => n.id),
      active_bets: [],
      learned: [],
      did_not_work: [],
      your_corrections: [],
      to_confirm: [],
      history: [],
    },
  } as BrainBusinessGraphV2
}

export const SECTION_ORDER: readonly BrainSection[] = [
  'active_bets',
  'learned',
  'did_not_work',
  'your_corrections',
  'to_confirm',
  'my_business',
  'history',
]

/** Relaciones que cuentan la historia de una conclusión, en orden del loop. */
const PATH_EDGES = new Set([
  'TARGETS',
  'USES',
  'SPEAKS_WITH',
  'TESTED_IN',
  'GIVES',
  'DERIVED_FROM',
  'ABOUT',
  'TEACHES',
  'SUPERSEDES',
  'INSPIRES',
  'SUGGESTS',
])

export interface PathStep {
  from: AnyNode
  relation: string
  to: AnyNode
}

/**
 * Ruta de una tarjeta (MLF-003): avatar → ángulo → apuesta → resultado →
 * veredicto → aprendizaje, recorriendo las relaciones del loop hasta 6 pasos.
 * Lista corta y legible en lugar del grafo completo.
 */
export function pathOf(
  graph: BrainBusinessGraphV2,
  nodeId: string,
  maxSteps = 8
): PathStep[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const edges = graph.edges.filter(e => PATH_EDGES.has(e.type))
  const seen = new Set([nodeId])
  const steps: PathStep[] = []
  let frontier = [nodeId]
  for (
    let depth = 0;
    depth < 6 && frontier.length && steps.length < maxSteps;
    depth++
  ) {
    const next: string[] = []
    for (const id of frontier) {
      for (const e of edges) {
        const other =
          e.source === id ? e.target : e.target === id ? e.source : null
        if (!other || seen.has(other)) continue
        const from = byId.get(e.source)
        const to = byId.get(e.target)
        if (!from || !to) continue
        seen.add(other)
        next.push(other)
        steps.push({ from, relation: e.type, to })
        if (steps.length >= maxSteps) break
      }
    }
    frontier = next
  }
  return steps
}

const V1_FAMILIES = new Set([
  'identity',
  'offer',
  'market',
  'competition',
  'channels',
  'strategy',
  'operations',
  'learning',
  'meta',
  'learned',
  'other',
])
const FAMILY_TO_V1: Record<string, string> = {
  bet: 'strategy',
  verdict: 'learning',
}

/** Para el grafo (vista secundaria), que conoce las familias v1. */
export function toGraphV1(graph: BrainBusinessGraphV2): BrainBusinessGraph {
  return {
    business_id: graph.business_id,
    nodes: graph.nodes.map(n => {
      const family =
        FAMILY_TO_V1[n.family] ??
        (V1_FAMILIES.has(n.family) ? n.family : 'other')
      return {
        id: n.id,
        type: n.type,
        family: family as BrainBusinessGraph['nodes'][number]['family'],
        label: n.label,
        summary: n.summary,
        state: n.state,
        provenance: n.provenance,
        mentions: n.mentions,
        created_at: n.created_at,
      }
    }),
    edges: graph.edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.type,
      fact: e.fact,
      provenance: e.provenance,
      valid_at: e.valid_at,
      invalid_at: e.invalid_at,
    })),
    stats: { nodes: graph.stats.nodes, edges: graph.stats.edges },
  }
}
