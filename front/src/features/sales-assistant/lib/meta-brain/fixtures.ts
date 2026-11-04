import type {
  BrainBusinessGraphV2,
  BrainSnapshotDiff,
  BrainSnapshots,
} from '../../types'
import {
  EDGE_FACTS,
  EDGE_GROUPS,
  NODE_SPECS,
  type NodeExtra,
  type NodeSpec,
} from './fixtures-data'
import { META_BRAIN_FAMILIES } from './palette'

/**
 * Fixtures del cerebro (solo laboratorio y pruebas): Dulce Abril Pastelería
 * con 27 días de aprendizajes, sus fotos guardadas, una comparación y un
 * grafo de estrés de 500 ideas / 2000 relaciones.
 */
type Graph = BrainBusinessGraphV2
type Node = Graph['nodes'][number]
type Edge = Graph['edges'][number]
type StrictNode = BrainSnapshotDiff['added'][number]

export const FIXTURE_BUSINESS_ID = '7c1e2a5b-3f4d-4b6a-9c8e-2d1f0a9b8c7d'
export const FIXTURE_BUSINESS_NAME = 'Dulce Abril Pastelería'
/** Día 1 = 3 oct 2026; hoy (día 27) = 29 oct 2026. */
const DAY_ONE = Date.UTC(2026, 9, 3)
const DAY = 86_400_000
export const FIXTURE_TODAY = DAY_ONE + 26 * DAY + 20 * 3_600_000

const TYPES: Record<string, [string, string]> = {
  identity: ['Identity', 'Identidad'],
  offer: ['Offering', 'Producto'],
  market: ['Audience', 'Público'],
  competition: ['Competitor', 'Competencia'],
  channels: ['Channel', 'Canal'],
  strategy: ['Strategy', 'Estrategia'],
  operations: ['Operation', 'Operación'],
  learning: ['Observation', 'Observación'],
  bet: ['Bet', 'Apuesta'],
  verdict: ['Verdict', 'Veredicto'],
  learned: ['Lesson', 'Aprendizaje'],
  meta: ['Setting', 'Ajuste'],
  other: ['Note', 'Nota'],
}

function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  return h >>> 0
}

function stamp(day: number, salt: string): string {
  const h = hash(salt)
  const ms =
    DAY_ONE + (day - 1) * DAY + (14 + (h % 6)) * 3_600_000 + (h % 60) * 60_000
  return new Date(ms).toISOString()
}

function provenanceOf(family: string, day: number, extra: NodeExtra): string {
  if (extra.p) return extra.p
  if (family === 'verdict' || family === 'learning')
    return 'inferred_from_platform'
  return day === 1 ? 'saleads_seed' : 'inferred'
}

function verificationOf(provenance: string, family: string): string {
  if (provenance === 'owner_said') return 'SELF_REPORTED'
  if (provenance === 'owner_decided') return 'HUMAN_VALIDATED'
  if (
    provenance === 'platform' ||
    provenance === 'saleads_seed' ||
    family === 'verdict'
  )
    return 'SYSTEM_VERIFIED'
  return 'INFERRED'
}

function toNode([
  id,
  family,
  day,
  mentions,
  label,
  extra = {},
]: NodeSpec): StrictNode {
  const provenance = provenanceOf(family, day, extra)
  const created = stamp(day, id)
  const learns = family === 'verdict' || family === 'learned'
  return {
    id,
    type: TYPES[family][0],
    family: family as StrictNode['family'],
    label,
    summary: extra.s ?? '',
    state: extra.st ?? (provenance === 'inferred' ? 'observed' : 'validated'),
    provenance,
    mentions,
    created_at: created,
    type_label: TYPES[family][1],
    stage: extra.sg ?? (learns ? 'vigente' : null),
    confidence: extra.c ?? null,
    verification:
      extra.st === 'proposed' ? 'PROPOSED' : verificationOf(provenance, family),
    valid_from: created,
    learned_at: learns ? created : null,
    superseded_by: extra.sup ?? null,
    scope: family === 'bet' ? 'Bogotá · Instagram y Facebook' : null,
    evidence_count: extra.ev ?? null,
    outcome: extra.o ?? null,
  }
}

function buildEdges(dayOf: Map<string, number>): Edge[] {
  const edges: Edge[] = []
  for (const [type, groups] of Object.entries(EDGE_GROUPS)) {
    for (const [source, ...targets] of groups) {
      for (const target of targets) {
        const day = Math.max(dayOf.get(source) ?? 1, dayOf.get(target) ?? 1)
        const retired =
          source === 'of-precio-viejo' || source === 'op-capacidad-vieja'
        edges.push({
          source,
          target,
          type,
          fact: EDGE_FACTS[`${source}>${target}`] ?? '',
          provenance: 'inferred',
          valid_at: stamp(day, `${source}${target}`),
          invalid_at: retired ? stamp(12, source) : null,
        })
      }
    }
  }
  return edges
}

const ACTIVE_STAGES = new Set(['en_prueba', 'lanzada', 'en_plan'])
const CORRECTIONS = new Set([
  'st-no-precio',
  'op-cobertura',
  'ot-mananas',
  'op-whatsapp-horario',
])

function sectionsOf(nodes: StrictNode[]): Graph['sections'] {
  const ids = (match: (node: StrictNode) => boolean) =>
    nodes.filter(match).map(n => n.id)
  const current = (n: StrictNode) => n.state !== 'superseded'
  return {
    active_bets: ids(
      n => n.family === 'bet' && ACTIVE_STAGES.has(n.stage ?? '')
    ),
    learned: ids(
      n =>
        (n.family === 'verdict' && n.outcome === 'win') ||
        n.family === 'learned' ||
        (n.family === 'learning' && n.state !== 'proposed')
    ),
    did_not_work: ids(n => n.outcome === 'loss'),
    your_corrections: ids(n => CORRECTIONS.has(n.id)),
    to_confirm: ids(n => n.state === 'proposed'),
    my_business: ids(
      n =>
        current(n) &&
        !['bet', 'verdict', 'learned', 'learning'].includes(n.family)
    ),
    history: ids(n => n.state === 'superseded'),
  }
}

export function metaBrainFixtureGraph(): Graph {
  const nodes = NODE_SPECS.map(toNode)
  const dayOf = new Map(NODE_SPECS.map(spec => [spec[0], spec[2]]))
  const edges = buildEdges(dayOf)
  return {
    business_id: FIXTURE_BUSINESS_ID,
    nodes: nodes as Node[],
    edges,
    stats: { nodes: nodes.length, edges: edges.length },
    sections: sectionsOf(nodes),
  }
}

function dayOfNode(node: Node): number {
  return (
    Math.round((Date.parse(node.created_at ?? '') - DAY_ONE) / DAY - 0.5) + 1
  )
}

/** El cerebro tal como estaba al final de un día (para fotos viejas en el laboratorio). */
export function graphAtDay(graph: Graph, day: number): Graph {
  const nodes = graph.nodes.filter(node => dayOfNode(node) <= day)
  const ids = new Set(nodes.map(node => node.id))
  const edges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target))
  const keep = (list: string[]) => list.filter(id => ids.has(id))
  const sections = Object.fromEntries(
    Object.entries(graph.sections).map(([key, list]) => [
      key,
      keep(list as string[]),
    ])
  ) as Graph['sections']
  return {
    ...graph,
    nodes,
    edges,
    sections,
    stats: { nodes: nodes.length, edges: edges.length },
  }
}

/** 20 fotos (una por día, del 8 al 27), la más nueva primero. */
export function metaBrainFixtureSnapshots(): BrainSnapshots['items'] {
  const graph = metaBrainFixtureGraph()
  return Array.from({ length: 20 }, (_, index) => {
    const day = 27 - index
    const at = graphAtDay(graph, day)
    const created = new Date(
      DAY_ONE + (day - 1) * DAY + 23 * 3_600_000
    ).toISOString()
    return {
      version: day - 7,
      created_at: created,
      generated_at: created,
      node_count: at.nodes.length,
      edge_count: at.edges.length,
    }
  })
}

const STAGE_BEFORE: Record<string, Partial<StrictNode>> = {
  'bt-rosales': { stage: 'en_plan' },
  'bt-halloween': { stage: 'en_plan' },
  'bt-carrusel': { stage: 'en_prueba', outcome: null },
  'ln-proceso': { confidence: 'media' },
  'ln-fin-semana': { confidence: 'media' },
}

/** «Qué cambió» del día 20 (foto 13) al 27 (foto 20). */
export function metaBrainFixtureDiff(): BrainSnapshotDiff {
  const nodes = NODE_SPECS.map(toNode)
  const added = nodes.filter(n => {
    const spec = NODE_SPECS.find(s => s[0] === n.id)
    return (spec?.[2] ?? 0) > 20
  })
  const modified = nodes
    .filter(n => STAGE_BEFORE[n.id])
    .map(after => ({
      id: after.id,
      before: { ...after, ...STAGE_BEFORE[after.id] },
      after,
    }))
  const removed = [
    toNode([
      'st-domingos',
      'strategy',
      15,
      2,
      'Probar pauta los domingos',
      { st: 'proposed' },
    ]),
  ]
  return {
    from: 13,
    to: 20,
    added,
    removed,
    modified,
    counts: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
    },
  }
}

const STRESS_TYPES = Object.keys(EDGE_GROUPS)

/** Grafo sintético en el límite del contrato (500 ideas, 2000 relaciones). */
export function stressGraph(nodeCount = 500, edgeCount = 2000): Graph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const family = META_BRAIN_FAMILIES[i % META_BRAIN_FAMILIES.length]
    const day = 1 + (hash(`d${i}`) % 27)
    return toNode([
      `n${i}`,
      family,
      day,
      1 + (hash(`m${i}`) % 30),
      `Idea ${i + 1}`,
    ])
  })
  const edges: Edge[] = Array.from({ length: edgeCount }, (_, i) => {
    const a = hash(`a${i}`) % nodeCount
    const near = (a + 1 + (hash(`b${i}`) % 40)) % nodeCount
    const b = i % 3 === 0 ? hash(`c${i}`) % nodeCount : near
    return {
      source: `n${a}`,
      target: `n${b === a ? (a + 1) % nodeCount : b}`,
      type: STRESS_TYPES[i % STRESS_TYPES.length],
      fact: '',
      provenance: 'inferred',
      valid_at: null,
      invalid_at: null,
    }
  })
  return {
    business_id: FIXTURE_BUSINESS_ID,
    nodes: nodes as Node[],
    edges,
    stats: { nodes: nodeCount, edges: edgeCount },
    sections: sectionsOf(nodes),
  }
}
