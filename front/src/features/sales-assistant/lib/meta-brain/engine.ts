import {
  centerOn,
  easeOutCubic,
  fitBounds,
  lerpCamera,
  zoomAt,
  type Camera,
} from './camera'
import { drawFrame, makeGlowSprite, nodeScreenRadius } from './draw'
import type { SceneModel } from './scene-model'

/**
 * Motor de la constelación: cámara, visibilidad por día, floraciones,
 * pulsos y el bucle de pintura. Sin React: el componente solo le pasa
 * eventos. El bucle corre mientras haya movimiento y la vista esté en
 * pantalla; con movimiento reducido pinta solo cuando algo cambia.
 */
export interface EngineView {
  day: number
  hidden: ReadonlySet<string>
  focus: Set<number> | null
  selected: number
  keyFocus: number
  /** Ancho (px) tapado por el panel de detalle a la derecha. */
  insetRight: number
  /** Ancho (px) tapado por la leyenda a la izquierda. */
  insetLeft: number
}

export interface EngineOptions {
  reduced: boolean
  font: string
  onHover?: (index: number, sx: number, sy: number) => void
  now?: () => number
  requestFrame?: (cb: (t: number) => void) => unknown
  cancelFrame?: (handle: unknown) => void
}

const PULSE_TYPES = [
  'GIVES',
  'TEACHES',
  'TESTED_IN',
  'INSPIRES',
  'SUGGESTS',
  'DERIVED_FROM',
]

export class ConstellationEngine {
  model: SceneModel | null = null
  cam: Camera = { x: 0, y: 0, k: 1 }
  fit: Camera = { x: 0, y: 0, k: 1 }
  view: EngineView = {
    day: Infinity,
    hidden: new Set(),
    focus: null,
    selected: -1,
    keyFocus: -1,
    insetRight: 0,
    insetLeft: 0,
  }
  hover = -1
  visible: boolean[] = []
  appear = new Float64Array(0)
  pulses: number[] = []
  private ctx: CanvasRenderingContext2D | null
  private width = 0
  private height = 0
  private dpr = 1
  private sprites = new Map<string, HTMLCanvasElement | null>()
  private flight: {
    from: Camera
    to: Camera
    start: number
    duration: number
  } | null = null
  private handle: unknown = null
  private active = true
  private moved = false
  private animateUntil = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private options: EngineOptions
  ) {
    this.ctx = canvas.getContext('2d')
  }

  private now(): number {
    return this.options.now?.() ?? performance.now()
  }

  setModel(model: SceneModel, { intro }: { intro: boolean }): void {
    this.model = model
    this.appear = new Float64Array(model.nodes.length)
    if (intro && !this.options.reduced) this.scheduleIntro(model)
    this.visible = this.visibleNow(model)
    this.refit(true)
    this.refresh()
  }

  private visibleNow(model: SceneModel): boolean[] {
    return model.nodes.map(
      n => n.day <= this.view.day && !this.view.hidden.has(n.family)
    )
  }

  private scheduleIntro(model: SceneModel) {
    const start = this.now() + 120
    const { minX, maxX, minY, maxY } = model.bounds
    const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY) / 2)
    model.nodes.forEach((node, i) => {
      this.appear[i] =
        start + (Math.hypot(node.x, node.y) / span) * 1100 + (i % 9) * 18
    })
    this.animateUntil = start + 2600
  }

  setView(next: Partial<EngineView>): void {
    const previousDay = this.view.day
    const previousLeft = this.view.insetLeft
    this.view = { ...this.view, ...next }
    if (
      this.model &&
      next.day !== undefined &&
      next.day > previousDay &&
      !this.options.reduced
    )
      this.scheduleGrowth(this.model, previousDay, next.day)
    this.refresh()
    if (this.view.insetLeft !== previousLeft) this.refit(!this.moved)
    else if (next.day !== undefined && next.day !== previousDay && !this.moved)
      this.reframe(previousDay === Infinity ? 0 : 900)
  }

  private scheduleGrowth(model: SceneModel, from: number, to: number) {
    const fresh = model.nodes
      .map((n, i) => (n.day > from && n.day <= to ? i : -1))
      .filter(i => i >= 0)
    const stagger = Math.min(55, 700 / Math.max(1, fresh.length))
    const start = this.now()
    fresh.forEach((i, rank) => (this.appear[i] = start + rank * stagger))
    this.animateUntil = Math.max(
      this.animateUntil,
      start + fresh.length * stagger + 1700
    )
  }

  private refresh() {
    const model = this.model
    if (!model) return
    this.visible = this.visibleNow(model)
    this.pulses = this.pickPulses(model)
    this.invalidate()
  }

  private pickPulses(model: SceneModel): number[] {
    const day = Math.min(
      this.view.day,
      model.nodes.reduce((m, n) => Math.max(m, n.day), 1)
    )
    const pick = (window: number) =>
      model.edges
        .map((e, i) => ({ e, i }))
        .filter(
          ({ e }) =>
            e.day > day - window &&
            e.day <= day &&
            this.visible[e.source] &&
            this.visible[e.target]
        )
    let recent = pick(4)
    if (recent.length < 8) recent = pick(8)
    return recent
      .sort(
        (a, b) =>
          Number(PULSE_TYPES.includes(b.e.type)) -
            Number(PULSE_TYPES.includes(a.e.type)) || b.e.day - a.e.day
      )
      .slice(0, 26)
      .map(({ i }) => i)
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width
    this.height = height
    this.dpr = dpr
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.refit(!this.moved)
    this.invalidate()
  }

  private refit(apply: boolean) {
    if (!this.model || !this.width) return
    const pad = Math.max(28, Math.min(this.width, this.height) * 0.07)
    const left =
      this.width - this.view.insetLeft > 320 ? this.view.insetLeft : 0
    const fit = fitBounds(
      this.model.bounds,
      this.width - left,
      this.height,
      pad
    )
    this.fit = { ...fit, x: fit.x + left }
    if (apply) this.cam = this.frame()
  }

  /**
   * Encuadre de lo visible: en los primeros días el cerebro se ve grande y
   * centrado; a medida que crece, la cámara se aleja (hasta ver todo).
   */
  private frame(): Camera {
    const model = this.model
    const count = this.visible.filter(Boolean).length
    if (!model || !count || count === model.nodes.length) return { ...this.fit }
    const b = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    }
    model.nodes.forEach((n, i) => {
      if (!this.visible[i]) return
      b.minX = Math.min(b.minX, n.x - n.r)
      b.minY = Math.min(b.minY, n.y - n.r)
      b.maxX = Math.max(b.maxX, n.x + n.r)
      b.maxY = Math.max(b.maxY, n.y + n.r)
    })
    const left =
      this.width - this.view.insetLeft > 320 ? this.view.insetLeft : 0
    const view = { left, top: 0, right: this.width, bottom: this.height }
    const pad = Math.max(40, Math.min(this.width, this.height) * 0.1)
    const framed = fitBounds(b, this.width - left, this.height, pad)
    const k = Math.min(framed.k, this.fit.k * 1.8)
    return centerOn(
      this.cam,
      (b.minX + b.maxX) / 2,
      (b.minY + b.maxY) / 2,
      view,
      k
    )
  }

  private reframe(duration: number) {
    if (!this.model || !this.width) return
    const target = this.frame()
    if (duration && !this.options.reduced) this.flyTo(target, duration)
    else {
      this.flight = null
      this.cam = target
      this.afterMove()
    }
  }

  private limits() {
    return { min: this.fit.k * 0.45, max: this.fit.k * 7 }
  }

  zoomBy(
    factor: number,
    sx = this.width / 2,
    sy = this.height / 2,
    animate = true
  ): void {
    const base = this.flight?.to ?? this.cam
    const target = zoomAt(base, sx, sy, factor, this.limits())
    this.moved = true
    if (animate) this.flyTo(target, 320)
    else {
      this.flight = null
      this.cam = target
      this.afterMove()
    }
  }

  panBy(dx: number, dy: number): void {
    this.flight = null
    this.moved = true
    this.cam = { ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy }
    this.afterMove()
  }

  reset(): void {
    this.moved = false
    this.flyTo(this.frame(), 600)
  }

  focusNode(index: number): void {
    const node = this.model?.nodes[index]
    if (!node) return
    const k = Math.max(this.cam.k, this.fit.k * 1.7)
    const view = {
      left: this.view.insetLeft,
      top: 0,
      right: this.width - this.view.insetRight,
      bottom: this.height,
    }
    this.moved = true
    this.flyTo(
      centerOn(this.cam, node.x, node.y, view, Math.min(k, this.limits().max)),
      700
    )
  }

  /** Si la idea quedó fuera del área visible (o bajo un panel), la trae al centro sin cambiar el zoom. */
  ensureVisible(index: number): void {
    const node = this.model?.nodes[index]
    if (!node) return
    const [x, y] = this.screenOf(index)
    const m = 56
    const inside =
      x >= this.view.insetLeft + m &&
      x <= this.width - this.view.insetRight - m &&
      y >= m &&
      y <= this.height - m
    if (inside) return
    const view = {
      left: this.view.insetLeft,
      top: 0,
      right: this.width - this.view.insetRight,
      bottom: this.height,
    }
    this.flyTo(centerOn(this.cam, node.x, node.y, view), 600)
  }

  private flyTo(target: Camera, duration: number) {
    if (this.options.reduced) {
      this.flight = null
      this.cam = target
      this.afterMove()
      return
    }
    this.flight = {
      from: { ...this.cam },
      to: target,
      start: this.now(),
      duration,
    }
    this.invalidate()
  }

  private afterMove() {
    if (this.hover >= 0) this.emitHover()
    this.invalidate()
  }

  screenOf(index: number): [number, number] {
    const node = this.model?.nodes[index]
    if (!node) return [0, 0]
    return [node.x * this.cam.k + this.cam.x, node.y * this.cam.k + this.cam.y]
  }

  hitAt(sx: number, sy: number): number {
    const model = this.model
    if (!model) return -1
    let best = -1
    let bestDistance = Infinity
    model.nodes.forEach((node, i) => {
      if (!this.visible[i]) return
      const [x, y] = this.screenOf(i)
      const d = Math.hypot(x - sx, y - sy)
      const reach = Math.max(
        9,
        nodeScreenRadius(node.r, this.cam.k, this.fit.k) + 5
      )
      if (d <= reach && d < bestDistance) {
        best = i
        bestDistance = d
      }
    })
    return best
  }

  setHover(index: number): void {
    if (index === this.hover) return
    this.hover = index
    this.emitHover()
    this.invalidate()
  }

  private emitHover() {
    const [x, y] = this.hover >= 0 ? this.screenOf(this.hover) : [0, 0]
    this.options.onHover?.(this.hover, x, y)
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active && this.handle !== null) {
      if (this.options.cancelFrame) this.options.cancelFrame(this.handle)
      else cancelAnimationFrame(this.handle as number)
      this.handle = null
    }
    if (active) this.invalidate()
  }

  invalidate(): void {
    if (!this.active || this.handle !== null) return
    const request =
      this.options.requestFrame ??
      ((cb: (t: number) => void) => requestAnimationFrame(cb))
    this.handle = request(() => this.tick())
  }

  private tick() {
    this.handle = null
    const now = this.now()
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.duration)
      this.cam = lerpCamera(this.flight.from, this.flight.to, easeOutCubic(t))
      if (t >= 1) this.flight = null
      if (this.hover >= 0) this.emitHover()
    }
    this.draw(now)
    const moving =
      !!this.flight || now < this.animateUntil || !this.options.reduced
    if (moving && this.visible.some(Boolean)) this.invalidate()
  }

  private draw(now: number) {
    if (!this.ctx || !this.model || !this.width) return
    const zoom = Math.max(
      1,
      Math.min(3, Math.pow(this.cam.k / this.fit.k, 1.2))
    )
    drawFrame(
      this.ctx,
      this.model,
      {
        width: this.width,
        height: this.height,
        dpr: this.dpr,
        cam: this.cam,
        fitK: this.fit.k,
        now,
        visible: this.visible,
        focus: this.view.focus,
        selected: this.view.selected,
        hover: this.hover,
        keyFocus: this.view.keyFocus,
        appear: this.appear,
        pulses: this.pulses,
        reduced: this.options.reduced,
        font: this.options.font,
        labelMax: Math.round(Math.max(5, Math.min(16, this.width / 92)) * zoom),
      },
      color => this.sprite(color)
    )
  }

  private sprite(color: string) {
    if (!this.sprites.has(color)) this.sprites.set(color, makeGlowSprite(color))
    return this.sprites.get(color) ?? null
  }

  destroy(): void {
    this.setActive(false)
    this.sprites.clear()
  }
}
