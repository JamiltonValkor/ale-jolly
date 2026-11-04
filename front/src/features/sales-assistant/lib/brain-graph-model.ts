import type { BrainBusinessGraph, BrainNode } from '../types'

/**
 * Modelo del grafo de «Mi cerebro» (OSF-001), portado de `graphModel.ts` y
 * `prepareGraph` del Explorer de ORQA y adaptado a la ontología de OSB-003:
 * cada familia es una comunidad con color propio, el layout es determinista
 * (ángulo áureo dentro de su comunidad) y las etiquetas son texto no confiable
 * (nunca se arma un enlace con ellas).
 */

export type BrainFamily = BrainNode['family']

export const BRAIN_FAMILY_COLORS: Record<BrainFamily, string> = {
  identity: '#9b6cff',
  offer: '#5c8dff',
  market: '#38c4c9',
  competition: '#ef6666',
  channels: '#8fcf59',
  strategy: '#e2b44f',
  operations: '#7296ff',
  learning: '#d573dc',
  meta: '#7f8ca7',
  learned: '#b368d1',
  other: '#697288',
}

export interface BrainModelNode {
  id: string
  label: string
  family: BrainFamily
  x: number
  y: number
  size: number
  color: string
}

export interface BrainModelEdge {
  id: string
  source: string
  target: string
  label: string
}

export interface BrainCommunity {
  family: BrainFamily
  count: number
}

export interface BrainGraphModel {
  nodes: BrainModelNode[]
  edges: BrainModelEdge[]
  communities: BrainCommunity[]
}

const GOLDEN_ANGLE = 2.399963229728653

function hashValue(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
}

export function compactLabel(value: string, maxLength = 28): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(1, maxLength - 1)).trim()}…`
}

function nodeSize(node: BrainNode): number {
  return Math.max(3, Math.min(9, 3 + Math.log2(node.mentions + 1) * 1.6))
}

function groupByFamily(nodes: BrainNode[]): Array<[BrainFamily, BrainNode[]]> {
  const groups = new Map<BrainFamily, BrainNode[]>()
  for (const node of nodes) {
    const items = groups.get(node.family) ?? []
    items.push(node)
    groups.set(node.family, items)
  }
  return [...groups.entries()].sort(
    (left, right) =>
      right[1].length - left[1].length || left[0].localeCompare(right[0])
  )
}

function placeCommunity(
  family: BrainFamily,
  nodes: BrainNode[],
  cx: number,
  cy: number
): BrainModelNode[] {
  const sorted = [...nodes].sort(
    (a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label)
  )
  const spread = Math.max(38, Math.min(112, 26 + Math.sqrt(sorted.length) * 10))
  return sorted.map((node, index) => {
    const angle = index * GOLDEN_ANGLE + (hashValue(node.id) % 17) / 17
    const distance =
      (Math.sqrt(index + 1) / Math.sqrt(sorted.length + 1)) * spread
    return {
      id: node.id,
      label: node.label,
      family,
      x: cx + Math.cos(angle) * distance,
      y: cy + Math.sin(angle) * distance,
      size: nodeSize(node),
      color: BRAIN_FAMILY_COLORS[family],
    }
  })
}

/** Foto de un negocio → nodos y aristas listos para pintar (aristas a nodos ausentes se descartan). */
export function toBrainGraphModel(graph: BrainBusinessGraph): BrainGraphModel {
  const groups = groupByFamily(graph.nodes)
  const radiusX = Math.max(170, 76 + groups.length * 17)
  const radiusY = Math.max(120, 60 + groups.length * 12)
  const nodes = groups.flatMap(([family, items], index) => {
    const angle =
      -Math.PI / 2 + (index / Math.max(groups.length, 1)) * Math.PI * 2
    return placeCommunity(
      family,
      items,
      Math.cos(angle) * radiusX,
      Math.sin(angle) * radiusY
    )
  })
  const ids = new Set(nodes.map(node => node.id))
  const edges = graph.edges
    .filter(edge => ids.has(edge.source) && ids.has(edge.target))
    .map((edge, index) => ({
      id: `e${index}`,
      source: edge.source,
      target: edge.target,
      label: edge.type,
    }))
  return {
    nodes,
    edges,
    communities: groups.map(([family, items]) => ({
      family,
      count: items.length,
    })),
  }
}
