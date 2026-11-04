import { META_BRAIN_FAMILIES, type MetaBrainFamily } from './palette'

/**
 * Layout de la constelación: una simulación de fuerzas pequeña, determinista
 * (semilla fija) y sin dependencias. Cada familia tiene su centro: identidad
 * en el medio (el negocio) y las demás en un anillo, con las apuestas y los
 * veredictos juntos (el loop). Dentro de cada familia lo más antiguo queda
 * cerca del centro y lo nuevo en el borde, así el cerebro crece hacia afuera
 * como los anillos de un árbol. Se resuelve completa antes de pintar.
 */
export interface LayoutNode {
  id: string
  family: MetaBrainFamily
  r: number
  /** Orden de llegada (menor = más antiguo). */
  age?: number
}

export interface LayoutLink {
  source: number
  target: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface LayoutResult {
  x: Float32Array
  y: Float32Array
  centers: Map<MetaBrainFamily, { x: number; y: number }>
  bounds: Bounds
}

const GOLDEN = 2.399963229728653
const CELL = 72

export function mulberry32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function familyCenters(
  counts: Map<MetaBrainFamily, number>,
  total: number
): Map<MetaBrainFamily, { x: number; y: number }> {
  const present = META_BRAIN_FAMILIES.filter(f => counts.has(f))
  const centers = new Map<MetaBrainFamily, { x: number; y: number }>()
  const ring = present.length > 1 ? present.filter(f => f !== 'identity') : []
  if (present.length === 1) centers.set(present[0], { x: 0, y: 0 })
  if (counts.has('identity')) centers.set('identity', { x: 0, y: 0 })
  const radius = 36 + Math.sqrt(total) * 11.5
  const weights = ring.map(f => Math.sqrt(counts.get(f) ?? 1) + 1.2)
  const sum = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  ring.forEach((family, index) => {
    const angle =
      -Math.PI / 2 + ((acc + weights[index] / 2) / sum) * Math.PI * 2
    acc += weights[index]
    centers.set(family, {
      x: Math.cos(angle) * radius * 1.9,
      y: Math.sin(angle) * radius,
    })
  })
  return centers
}

interface Sim {
  n: number
  x: Float32Array
  y: Float32Array
  vx: Float32Array
  vy: Float32Array
  r: Float32Array
  cx: Float32Array
  cy: Float32Array
  /** Radio objetivo dentro de su familia (anillos de edad). */
  ring: Float32Array
}

function cellKey(gx: number, gy: number): number {
  return (gx + 32768) * 65536 + (gy + 32768)
}

function buildGrid(sim: Sim, cell: number): Map<number, number[]> {
  const grid = new Map<number, number[]>()
  for (let i = 0; i < sim.n; i++) {
    const key = cellKey(
      Math.floor(sim.x[i] / cell),
      Math.floor(sim.y[i] / cell)
    )
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  }
  return grid
}

function forPairs(
  sim: Sim,
  cell: number,
  visit: (i: number, j: number) => void
) {
  const grid = buildGrid(sim, cell)
  for (let i = 0; i < sim.n; i++) {
    const gx = Math.floor(sim.x[i] / cell)
    const gy = Math.floor(sim.y[i] / cell)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(gx + dx, gy + dy))
        if (bucket) for (const j of bucket) if (j > i) visit(i, j)
      }
  }
}

function repel(sim: Sim, alpha: number) {
  const k = 120 * alpha
  forPairs(sim, CELL, (i, j) => {
    const dx = sim.x[i] - sim.x[j]
    const dy = sim.y[i] - sim.y[j]
    const d2 = dx * dx + dy * dy + 0.01
    if (d2 > CELL * CELL) return
    const f = k / d2
    sim.vx[i] += dx * f
    sim.vy[i] += dy * f
    sim.vx[j] -= dx * f
    sim.vy[j] -= dy * f
  })
}

function springs(
  sim: Sim,
  links: LayoutLink[],
  same: boolean[],
  alpha: number
) {
  links.forEach((link, index) => {
    const { source: s, target: t } = link
    const dx = sim.x[t] - sim.x[s]
    const dy = sim.y[t] - sim.y[s]
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01
    const f =
      ((d - (same[index] ? 44 : 120)) / d) *
      (same[index] ? 0.045 : 0.006) *
      alpha
    sim.vx[s] += dx * f
    sim.vy[s] += dy * f
    sim.vx[t] -= dx * f
    sim.vy[t] -= dy * f
  })
}

function gravity(sim: Sim, alpha: number) {
  const pull = 0.03 * (0.35 + 0.65 * alpha)
  for (let i = 0; i < sim.n; i++) {
    const dx = sim.cx[i] - sim.x[i]
    const dy = sim.cy[i] - sim.y[i]
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01
    const radial = ((d - sim.ring[i]) / d) * 0.04
    sim.vx[i] += dx * (pull + radial * alpha)
    sim.vy[i] += dy * (pull + radial * alpha)
  }
}

function integrate(sim: Sim) {
  for (let i = 0; i < sim.n; i++) {
    sim.vx[i] = Math.max(-14, Math.min(14, sim.vx[i] * 0.6))
    sim.vy[i] = Math.max(-14, Math.min(14, sim.vy[i] * 0.6))
    sim.x[i] += sim.vx[i]
    sim.y[i] += sim.vy[i]
  }
}

function collide(sim: Sim, cell: number) {
  forPairs(sim, cell, (i, j) => {
    const dx = sim.x[i] - sim.x[j]
    const dy = sim.y[i] - sim.y[j]
    const min = sim.r[i] + sim.r[j] + 6
    const d2 = dx * dx + dy * dy
    if (d2 >= min * min) return
    const d = Math.sqrt(d2) || 0.01
    const push = ((min - d) / d) * 0.5
    const ux = d2 ? dx : 0.01
    sim.x[i] += ux * push
    sim.y[i] += dy * push
    sim.x[j] -= ux * push
    sim.y[j] -= dy * push
  })
}

function seed(
  nodes: LayoutNode[],
  centers: LayoutResult['centers'],
  seedValue: number
): Sim {
  const n = nodes.length
  const rand = mulberry32(seedValue)
  const sim: Sim = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    r: Float32Array.from(nodes.map(node => node.r)),
    cx: new Float32Array(n),
    cy: new Float32Array(n),
    ring: new Float32Array(n),
  }
  const members = new Map<MetaBrainFamily, number[]>()
  nodes.forEach((node, i) =>
    members.set(node.family, [...(members.get(node.family) ?? []), i])
  )
  for (const [family, list] of members) {
    const center = centers.get(family) ?? { x: 0, y: 0 }
    const sorted = [...list].sort(
      (a, b) => (nodes[a].age ?? 0) - (nodes[b].age ?? 0) || a - b
    )
    const spread = 20 + Math.sqrt(sorted.length) * 8
    sorted.forEach((i, rank) => {
      const angle = rank * GOLDEN + rand() * 0.6
      const distance = Math.sqrt(rank + 0.5) * spread * 0.55
      sim.cx[i] = center.x
      sim.cy[i] = center.y
      sim.ring[i] = Math.sqrt(rank + 0.5) * spread * 0.5
      sim.x[i] = center.x + Math.cos(angle) * distance
      sim.y[i] = center.y + Math.sin(angle) * distance
    })
  }
  return sim
}

function boundsOf(sim: Sim): Bounds {
  if (!sim.n) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (let i = 0; i < sim.n; i++) {
    b.minX = Math.min(b.minX, sim.x[i] - sim.r[i])
    b.minY = Math.min(b.minY, sim.y[i] - sim.r[i])
    b.maxX = Math.max(b.maxX, sim.x[i] + sim.r[i])
    b.maxY = Math.max(b.maxY, sim.y[i] + sim.r[i])
  }
  return b
}

export function layoutConstellation(
  nodes: LayoutNode[],
  links: LayoutLink[],
  options: { seed?: number; ticks?: number } = {}
): LayoutResult {
  const counts = new Map<MetaBrainFamily, number>()
  nodes.forEach(node =>
    counts.set(node.family, (counts.get(node.family) ?? 0) + 1)
  )
  const centers = familyCenters(counts, nodes.length)
  const sim = seed(nodes, centers, options.seed ?? 27)
  const valid = links.filter(
    l =>
      l.source !== l.target &&
      l.source < nodes.length &&
      l.target < nodes.length
  )
  const same = valid.map(l => nodes[l.source].family === nodes[l.target].family)
  const ticks =
    options.ticks ??
    (nodes.length <= 200 ? 300 : nodes.length <= 350 ? 220 : 170)
  const maxR = nodes.reduce((m, node) => Math.max(m, node.r), 1)
  for (let tick = 0; tick < ticks; tick++) {
    const alpha = Math.pow(1 - tick / ticks, 1.3)
    repel(sim, alpha)
    springs(sim, valid, same, alpha)
    gravity(sim, alpha)
    integrate(sim)
    if (tick % 3 === 0 || tick > ticks - 40) collide(sim, maxR * 2 + 8)
  }
  for (let pass = 0; pass < 8; pass++) collide(sim, maxR * 2 + 8)
  return { x: sim.x, y: sim.y, centers, bounds: boundsOf(sim) }
}
