import { compactLabel } from '../brain-graph-model'
import type { Camera } from './camera'
import { quadPoint, splitQuad } from './geometry'
import { placeLabels, type Box, type LabelCandidate } from './labels'
import { IRIDESCENCE, OUTCOME_COLOR, rgba } from './palette'
import type { SceneModel } from './scene-model'

/**
 * Pintura de la constelación en Canvas2D, en espacio de pantalla. Negro
 * puro; puntos que brillan con sprites de resplandor (composición aditiva);
 * aristas curvas de un pelo a tinta .08 que se encienden alrededor de lo
 * activo; pulsos que viajan por lo aprendido hace poco; anillo iridiscente
 * para las apuestas y anillo de resultado para los veredictos; etiquetas con
 * halo oscuro, sin encimarse.
 */
export interface DrawState {
  width: number
  height: number
  dpr: number
  cam: Camera
  fitK: number
  now: number
  visible: boolean[]
  focus: Set<number> | null
  selected: number
  hover: number
  keyFocus: number
  /** Momento en que apareció cada nodo (0 = siempre estuvo). */
  appear: Float64Array
  pulses: number[]
  reduced: boolean
  font: string
  labelMax: number
}

export type SpriteFor = (color: string) => CanvasImageSource | null

export interface Projected {
  sx: Float32Array
  sy: Float32Array
  sr: Float32Array
  alpha: Float32Array
  bloom: Float32Array
}

const BLOOM_MS = 900

/** Radio en pantalla: al acercar crece más lento que el espacio, y nunca baja de un mínimo legible. */
export function nodeScreenRadius(r: number, k: number, fitK: number): number {
  return r * Math.max(fitK, 0.58) * Math.pow(k / fitK, 0.6)
}

/** 0 → 1 con un pequeño rebote al final. */
export function bloomScale(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const c = 1.9
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

function activeSet(model: SceneModel, s: DrawState): Set<number> | null {
  const active = s.selected >= 0 ? s.selected : s.hover
  if (active < 0) return null
  return new Set([active, ...model.neighbors[active]])
}

export function projectNodes(model: SceneModel, s: DrawState): Projected {
  const n = model.nodes.length
  const out: Projected = {
    sx: new Float32Array(n),
    sy: new Float32Array(n),
    sr: new Float32Array(n),
    alpha: new Float32Array(n),
    bloom: new Float32Array(n),
  }
  const near = activeSet(model, s)
  for (let i = 0; i < n; i++) {
    const node = model.nodes[i]
    out.sx[i] = node.x * s.cam.k + s.cam.x
    out.sy[i] = node.y * s.cam.k + s.cam.y
    out.sr[i] = nodeScreenRadius(node.r, s.cam.k, s.fitK)
    const t = s.appear[i] ? (s.now - s.appear[i]) / BLOOM_MS : 1
    out.bloom[i] = s.visible[i] ? bloomScale(t) : 0
    if (!s.visible[i] || t <= 0) continue
    let alpha = 1
    if (s.focus && !s.focus.has(i)) alpha = 0.14
    if (near && !near.has(i)) alpha = Math.min(alpha, 0.26)
    out.alpha[i] = alpha
  }
  return out
}

function edgeProgress(s: DrawState, a: number, b: number): number {
  const start = Math.max(s.appear[a], s.appear[b])
  if (!start) return 1
  return Math.min(1, Math.max(0, (s.now - start - 260) / 650))
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected
) {
  const near = s.selected >= 0 ? s.selected : s.hover
  const dimmed = near >= 0 || s.focus !== null
  const lit: number[] = []
  ctx.lineWidth = 0.9
  ctx.strokeStyle = `rgba(255,255,255,${dimmed ? 0.04 : 0.1})`
  ctx.beginPath()
  model.edges.forEach((e, index) => {
    if (!p.alpha[e.source] || !p.alpha[e.target]) return
    const progress = edgeProgress(s, e.source, e.target)
    if (progress <= 0) return
    if (
      e.source === near ||
      e.target === near ||
      (s.focus?.has(e.source) && s.focus.has(e.target))
    )
      lit.push(index)
    const cx = e.cx * s.cam.k + s.cam.x
    const cy = e.cy * s.cam.k + s.cam.y
    const seg =
      progress < 1
        ? splitQuad(
            p.sx[e.source],
            p.sy[e.source],
            cx,
            cy,
            p.sx[e.target],
            p.sy[e.target],
            progress
          )
        : [
            p.sx[e.source],
            p.sy[e.source],
            cx,
            cy,
            p.sx[e.target],
            p.sy[e.target],
          ]
    ctx.moveTo(seg[0], seg[1])
    ctx.quadraticCurveTo(seg[2], seg[3], seg[4], seg[5])
  })
  ctx.stroke()
  drawLitEdges(ctx, model, s, p, lit, near)
}

function drawLitEdges(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected,
  lit: number[],
  near: number
) {
  if (!lit.length) return
  ctx.lineWidth = near >= 0 ? 1.15 : 0.9
  for (const index of lit) {
    const e = model.edges[index]
    const other = e.source === near ? e.target : e.source
    const color = near >= 0 ? model.nodes[other].color : '#FFFFFF'
    ctx.strokeStyle = rgba(color, near >= 0 ? 0.55 : 0.2)
    ctx.beginPath()
    ctx.moveTo(p.sx[e.source], p.sy[e.source])
    ctx.quadraticCurveTo(
      e.cx * s.cam.k + s.cam.x,
      e.cy * s.cam.k + s.cam.y,
      p.sx[e.target],
      p.sy[e.target]
    )
    ctx.stroke()
  }
}

function drawPulses(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected,
  sprite: SpriteFor
) {
  if (s.reduced || !s.pulses.length) return
  ctx.globalCompositeOperation = 'lighter'
  for (const index of s.pulses) {
    const e = model.edges[index]
    if (
      !e ||
      !p.alpha[e.source] ||
      !p.alpha[e.target] ||
      edgeProgress(s, e.source, e.target) < 1
    )
      continue
    const period = 2600 + e.phase * 2200
    const t = (s.now / period + e.phase) % 1
    const [x, y] = quadPoint(
      p.sx[e.source],
      p.sy[e.source],
      e.cx * s.cam.k + s.cam.x,
      e.cy * s.cam.k + s.cam.y,
      p.sx[e.target],
      p.sy[e.target],
      t
    )
    const image = sprite(model.nodes[e.target].color)
    if (!image) continue
    const size = 13
    ctx.globalAlpha =
      Math.sin(Math.PI * t) *
      0.85 *
      Math.min(p.alpha[e.source], p.alpha[e.target])
    ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function drawGlows(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected,
  sprite: SpriteFor
) {
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < model.nodes.length; i++) {
    if (!p.alpha[i]) continue
    const node = model.nodes[i]
    if (node.superseded) continue
    const image = sprite(node.color)
    if (!image) continue
    const twinkle = s.reduced
      ? 1
      : 0.86 + 0.14 * Math.sin(s.now / 1700 + i * 1.7)
    const standout = node.family === 'bet' || node.family === 'verdict'
    const size = p.sr[i] * (standout ? 9.5 : 7.6) * p.bloom[i]
    ctx.globalAlpha = p.alpha[i] * twinkle * (standout ? 0.95 : 0.85)
    ctx.drawImage(image, p.sx[i] - size / 2, p.sy[i] - size / 2, size, size)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function circle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number
) {
  ctx.beginPath()
  ctx.arc(x, y, Math.max(0.4, r), 0, Math.PI * 2)
}

function drawCores(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  p: Projected
) {
  for (let i = 0; i < model.nodes.length; i++) {
    if (!p.alpha[i]) continue
    const node = model.nodes[i]
    const r = p.sr[i] * p.bloom[i]
    ctx.globalAlpha = p.alpha[i]
    if (node.superseded) {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'
      ctx.lineWidth = 1
      circle(ctx, p.sx[i], p.sy[i], r * 0.7)
      ctx.stroke()
      continue
    }
    ctx.fillStyle = node.color
    circle(ctx, p.sx[i], p.sy[i], r * 0.62)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    circle(ctx, p.sx[i], p.sy[i], r * 0.28)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function iridescentStroke(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number
) {
  if (typeof ctx.createConicGradient !== 'function') return IRIDESCENCE[1]
  const gradient = ctx.createConicGradient(angle, x, y)
  IRIDESCENCE.forEach((color, index) =>
    gradient.addColorStop(index / IRIDESCENCE.length, color)
  )
  gradient.addColorStop(1, IRIDESCENCE[0])
  return gradient
}

function drawRings(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected
) {
  for (let i = 0; i < model.nodes.length; i++) {
    if (!p.alpha[i] || p.bloom[i] < 0.2) continue
    const node = model.nodes[i]
    const r = p.sr[i] * p.bloom[i]
    if (node.family === 'bet' && !node.superseded) {
      ctx.globalAlpha = p.alpha[i] * 0.95
      ctx.lineWidth = 1.3
      ctx.strokeStyle = iridescentStroke(
        ctx,
        p.sx[i],
        p.sy[i],
        s.reduced ? 0 : s.now / 2400 + i
      )
      circle(ctx, p.sx[i], p.sy[i], r * 1.45 + 2)
      ctx.stroke()
    } else if (node.family === 'verdict' && node.outcome) {
      ctx.globalAlpha = p.alpha[i] * 0.9
      ctx.lineWidth = 1.2
      ctx.strokeStyle = OUTCOME_COLOR[node.outcome]
      circle(ctx, p.sx[i], p.sy[i], r * 1.35 + 2)
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

function drawBlooms(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected
) {
  if (s.reduced) return
  ctx.lineWidth = 1
  for (let i = 0; i < model.nodes.length; i++) {
    if (!s.appear[i] || !p.alpha[i]) continue
    const t = (s.now - s.appear[i]) / BLOOM_MS
    if (t <= 0 || t >= 1) continue
    ctx.globalAlpha = (1 - t) * 0.6
    ctx.strokeStyle = model.nodes[i].color
    circle(ctx, p.sx[i], p.sy[i], p.sr[i] * (1.2 + 3.6 * t))
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawMarks(ctx: CanvasRenderingContext2D, s: DrawState, p: Projected) {
  const marks: Array<[number, number, number, number]> = [
    [s.hover, 0.6, 1, 4],
    [s.selected, 0.95, 1.5, 5],
    [s.keyFocus, 0.95, 2, 7],
  ]
  for (const [index, alpha, width, gap] of marks) {
    if (index < 0 || !p.alpha[index]) continue
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`
    ctx.lineWidth = width
    circle(ctx, p.sx[index], p.sy[index], p.sr[index] + gap)
    ctx.stroke()
  }
  if (s.selected >= 0 && p.alpha[s.selected] && !s.reduced) {
    const t = (s.now % 2200) / 2200
    ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.35})`
    ctx.lineWidth = 1
    circle(
      ctx,
      p.sx[s.selected],
      p.sy[s.selected],
      p.sr[s.selected] + 5 + t * 10
    )
    ctx.stroke()
  }
}

const widths = new Map<string, number>()

function labelCandidates(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected
) {
  const pinned = new Set(
    [s.selected, s.hover, s.keyFocus].filter(i => i >= 0 && p.alpha[i])
  )
  const candidates: LabelCandidate[] = []
  for (const i of model.order) {
    if (!p.alpha[i] || p.bloom[i] < 0.6 || (p.alpha[i] < 0.5 && !pinned.has(i)))
      continue
    if (candidates.length > 70 && !pinned.has(i)) continue
    const text = compactLabel(model.nodes[i].label, 34)
    const key = `${s.font}|${text}`
    const width = widths.get(key) ?? ctx.measureText(text).width
    widths.set(key, width)
    candidates.push({
      index: i,
      x: p.sx[i],
      y: p.sy[i],
      r: p.sr[i] + 2,
      width,
      height: 13,
      priority: model.nodes[i].importance,
      pinned: pinned.has(i),
    })
  }
  return candidates
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  p: Projected
) {
  ctx.font = `500 12px ${s.font}`
  const obstacles: Box[] = []
  for (let i = 0; i < model.nodes.length; i++)
    if (p.alpha[i] > 0.5 && p.sr[i] >= 2.5) {
      const core = p.sr[i] * 0.7
      obstacles.push({
        x: p.sx[i] - core,
        y: p.sy[i] - core,
        w: core * 2,
        h: core * 2,
      })
    }
  const placed = placeLabels(labelCandidates(ctx, model, s, p), {
    viewport: { width: s.width, height: s.height },
    max: s.labelMax,
    obstacles,
    strong: Math.min(6, Math.ceil(s.labelMax / 2)),
  })
  ctx.lineJoin = 'round'
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(0,0,0,0.88)'
  for (const label of placed) {
    const text = compactLabel(model.nodes[label.index].label, 34)
    const strong =
      label.index === s.selected ||
      label.index === s.hover ||
      label.index === s.keyFocus
    ctx.textAlign =
      label.align === 'right'
        ? 'left'
        : label.align === 'left'
          ? 'right'
          : 'center'
    ctx.globalAlpha = Math.min(1, p.alpha[label.index] + 0.2)
    ctx.strokeText(text, label.textX, label.textY)
    ctx.fillStyle = strong ? 'rgba(255,255,255,0.97)' : 'rgba(255,255,255,0.72)'
    ctx.fillText(text, label.textX, label.textY)
  }
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  s: DrawState,
  sprite: SpriteFor
): void {
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, s.width, s.height)
  const p = projectNodes(model, s)
  drawEdges(ctx, model, s, p)
  drawPulses(ctx, model, s, p, sprite)
  drawGlows(ctx, model, s, p, sprite)
  drawCores(ctx, model, p)
  drawRings(ctx, model, s, p)
  drawBlooms(ctx, model, s, p)
  drawMarks(ctx, s, p)
  drawLabels(ctx, model, s, p)
}

/** Resplandor radial de un color, pintado una vez y reutilizado. */
export function makeGlowSprite(
  color: string,
  size = 96
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const half = size / 2
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
  gradient.addColorStop(0, rgba(color, 1))
  gradient.addColorStop(0.1, rgba(color, 0.8))
  gradient.addColorStop(0.28, rgba(color, 0.26))
  gradient.addColorStop(0.55, rgba(color, 0.07))
  gradient.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return canvas
}
