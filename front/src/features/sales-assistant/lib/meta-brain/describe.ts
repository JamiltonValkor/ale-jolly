import type { BrainBusinessGraphV2, BrainSnapshotDiff } from '../../types'

/**
 * Del dato a la frase: relaciones como oraciones («Torta de tres leches le
 * habla a Mamás de 28 a 42 años») y cambios entre fotos («pasó de En prueba a
 * Ganó en esta prueba»). La vista traduce; aquí solo se decide qué decir.
 */
type Graph = BrainBusinessGraphV2
type DiffNode = BrainSnapshotDiff['modified'][number]['before']

export function humanizeToken(token: string): string {
  const words = token.replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : ''
}

export interface RelationLine {
  key: string
  relation: string
  direction: 'out' | 'in'
  otherId: string
  otherLabel: string
  fact: string | null
}

const LOOP_FIRST = [
  'GIVES',
  'TEACHES',
  'TESTED_IN',
  'INSPIRES',
  'SUGGESTS',
  'DERIVED_FROM',
  'SUPERSEDES',
]

function weight(relation: string): number {
  const index = LOOP_FIRST.indexOf(relation)
  return index < 0 ? LOOP_FIRST.length : index
}

/** Relaciones vigentes de una idea, primero las del loop y las que traen un hecho. */
export function relationsOf(
  graph: Graph,
  nodeId: string,
  limit = 24
): RelationLine[] {
  const labels = new Map(graph.nodes.map(n => [n.id, n.label]))
  const mentions = new Map(graph.nodes.map(n => [n.id, n.mentions]))
  return graph.edges
    .filter(
      e => e.invalid_at === null && (e.source === nodeId || e.target === nodeId)
    )
    .map((e, index) => {
      const direction = e.source === nodeId ? ('out' as const) : ('in' as const)
      const otherId = direction === 'out' ? e.target : e.source
      return {
        key: `${e.source}-${e.type}-${e.target}-${index}`,
        relation: e.type,
        direction,
        otherId,
        otherLabel: labels.get(otherId) ?? '',
        fact: e.fact ? e.fact : null,
      }
    })
    .filter(line => line.otherLabel && line.otherId !== nodeId)
    .sort(
      (a, b) =>
        Number(!!b.fact) - Number(!!a.fact) ||
        weight(a.relation) - weight(b.relation) ||
        (mentions.get(b.otherId) ?? 0) - (mentions.get(a.otherId) ?? 0)
    )
    .slice(0, limit)
}

export type ChangeLine =
  | { kind: 'stage'; from: string | null; to: string | null }
  | {
      kind: 'confidence'
      from: string | null
      to: string | null
      direction: 'up' | 'down'
    }
  | { kind: 'label'; from: string; to: string }
  | { kind: 'replaced'; by: string }

const CONFIDENCE = ['baja', 'media', 'alta']

export function changeLines(before: DiffNode, after: DiffNode): ChangeLine[] {
  const lines: ChangeLine[] = []
  if (before.label !== after.label)
    lines.push({ kind: 'label', from: before.label, to: after.label })
  if (before.stage !== after.stage)
    lines.push({ kind: 'stage', from: before.stage, to: after.stage })
  if (before.confidence !== after.confidence) {
    const up =
      CONFIDENCE.indexOf(after.confidence ?? '') >
      CONFIDENCE.indexOf(before.confidence ?? '')
    lines.push({
      kind: 'confidence',
      from: before.confidence,
      to: after.confidence,
      direction: up ? 'up' : 'down',
    })
  }
  if (!before.superseded_by && after.superseded_by)
    lines.push({ kind: 'replaced', by: after.superseded_by })
  return lines
}
