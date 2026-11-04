// TDD-SKIP: WebGLRenderer + requestAnimationFrame loop; needs a real GPU context. Pose logic is covered by rig/*.test.ts, model and pose binding by companion-model/pose-binding tests, lifecycle by use-companion-scene.test.tsx.
import * as THREE from 'three'

import { isCalmAction } from '../rig/companion-actions'
import type {
  CompanionAction,
  CompanionMood,
  PointDirection,
} from '../rig/companion-moods'
import {
  createRigState,
  stepRig,
  triggerAction,
  type RigInput,
  type RigState,
} from '../rig/companion-rig'
import type { InteractionEvent } from '../rig/interaction'
import {
  createDriver,
  driverEvent,
  releaseDue,
  type DriverState,
} from '../rig/interaction-driver'
import { mulberry32, type Rng } from '../rig/random'
import {
  resolveRenderQuality,
  type RenderQuality,
  type RequestedFraming,
} from '../rig/render-quality'
import type { VisemeShape } from '../speech/lipsync'
import { buildCompanionModel, type CompanionModel } from './companion-model'
import {
  applyPose,
  createPoseMemory,
  frameCamera,
  type PoseMemory,
} from './pose-binding'

export interface CompanionSceneOptions {
  mood: CompanionMood
  reducedMotion: boolean
  speakingLevel?: number | null
  /** Semilla del azar (fidgets, parpadeos, ruido): capturas reproducibles. */
  seed?: number
  interactive?: boolean
  direction?: PointDirection
  /** 'head' = primer plano de la capucha (sin brazos ni pies). Fijo al montar. */
  framing?: RequestedFraming
  onFirstFrame?: () => void
  onContextLost?: () => void
}

export interface ScenePointer {
  x: number
  y: number
  /** Distancia al personaje en radios del lienzo (para «te nota»). */
  distance: number
}

/** API que el componente React usa para hablar con la escena. */
export interface CompanionSceneApi {
  setMood(mood: CompanionMood): void
  setSpeakingLevel(level: number | null | undefined): void
  setPointer(pointer: ScenePointer | null): void
  setReducedMotion(reduced: boolean): void
  setInteractive(interactive: boolean): void
  setDirection(direction: PointDirection): void
  /** Fuente del visema actual (lip-sync de `say`); null = sin texto. */
  setVisemeSource(source: (() => VisemeShape | null) | null): void
  play(action: CompanionAction, opts?: { direction?: PointDirection }): void
  /** Alias de `play` (API anterior). */
  gesture(action: CompanionAction): void
  pointerEnter(): void
  pointerLeave(): void
  pointerClick(): void
  resize(width: number, height: number): void
  setVisible(visible: boolean): void
  dispose(): void
}

const MAX_DT = 0.1

function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: 'default',
  })
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.02
  renderer.outputColorSpace = THREE.SRGBColorSpace
  return renderer
}

export class CompanionScene implements CompanionSceneApi {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(22, 1, 0.1, 60)
  private readonly model: CompanionModel
  private quality: RenderQuality
  private rig: RigState
  private driver: DriverState
  private readonly rng: Rng
  private readonly memory: PoseMemory = createPoseMemory()
  private input: RigInput
  private interactive: boolean
  private readonly framing: RequestedFraming
  private visemeSource: (() => VisemeShape | null) | null = null
  private frame: number | null = null
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private last = 0
  private visible = true
  private disposed = false
  private firstFrameSent = false
  private readonly opts: CompanionSceneOptions

  constructor(canvas: HTMLCanvasElement, opts: CompanionSceneOptions) {
    this.opts = opts
    this.renderer = createRenderer(canvas)
    const seed = opts.seed ?? (Math.random() * 2 ** 31) >>> 0
    this.rng = mulberry32(seed)
    this.interactive = !!opts.interactive
    this.input = {
      mood: opts.mood,
      reducedMotion: opts.reducedMotion,
      speakingLevel: opts.speakingLevel,
      pointer: null,
      direction: opts.direction ?? 1,
    }
    this.rig = createRigState(opts.mood, {
      rng: this.rng,
      reducedMotion: opts.reducedMotion,
      seed: (seed % 997) + 1,
    })
    this.driver = createDriver(0)
    this.framing = opts.framing ?? 'full'
    this.quality = resolveRenderQuality(
      canvas.clientWidth || 300,
      canvas.clientHeight || 300,
      window.devicePixelRatio,
      this.framing
    )
    this.model = buildCompanionModel(this.quality, {
      headOnly: this.framing === 'head',
    })
    this.scene.add(this.model.root, this.model.shadow)
    this.last = performance.now()
    canvas.addEventListener('webglcontextlost', this.handleContextLost)
    document.addEventListener('visibilitychange', this.handleVisibility)
  }

  setMood(mood: CompanionMood) {
    this.input = { ...this.input, mood }
    this.wake()
  }

  setSpeakingLevel(level: number | null | undefined) {
    this.input = { ...this.input, speakingLevel: level }
    if (this.input.mood === 'speaking') this.wake()
  }

  setPointer(pointer: ScenePointer | null) {
    this.input = {
      ...this.input,
      pointer: pointer ? { x: pointer.x, y: pointer.y } : null,
    }
    if (pointer && this.interactive) {
      this.driver = driverEvent(
        this.driver,
        { type: 'move', distance: pointer.distance },
        this.rig.time
      )
    }
    if (!this.input.reducedMotion) this.wake()
  }

  setReducedMotion(reduced: boolean) {
    this.input = { ...this.input, reducedMotion: reduced }
    this.wake()
  }

  setInteractive(interactive: boolean) {
    this.interactive = interactive
    if (interactive) this.driver = createDriver(this.rig.time)
    this.wake()
  }

  setDirection(direction: PointDirection) {
    this.input = { ...this.input, direction }
    this.wake()
  }

  setVisemeSource(source: (() => VisemeShape | null) | null) {
    this.visemeSource = source
    this.wake()
  }

  play(action: CompanionAction, opts: { direction?: PointDirection } = {}) {
    if (this.input.reducedMotion && !isCalmAction(action)) return
    this.rig = triggerAction(this.rig, action, {
      direction: opts.direction ?? this.input.direction,
    })
    this.wake()
  }

  gesture(action: CompanionAction) {
    this.play(action)
  }

  pointerEnter() {
    this.interactionEvent({ type: 'enter' })
  }

  pointerLeave() {
    this.interactionEvent({ type: 'leave' })
  }

  /** Cada toque, un movimiento distinto (sin repetir ni cortar el que está en curso). */
  pointerClick() {
    const active = this.rig.actions.map(a => a.kind)
    this.interactionEvent({
      type: 'click',
      tap: { rng: this.rng, reducedMotion: this.input.reducedMotion, active },
    })
  }

  resize(width: number, height: number) {
    if (this.disposed || width < 1 || height < 1) return
    const next = resolveRenderQuality(
      width,
      height,
      window.devicePixelRatio,
      this.framing
    )
    this.renderer.setPixelRatio(next.pixelRatio)
    this.renderer.setSize(width, height, false)
    frameCamera(this.camera, width / height, next.framing)
    if (next.shells !== this.quality.shells || next.tier !== this.quality.tier)
      this.model.setQuality(next)
    this.quality = next
    this.renderFrame(0)
    this.wake()
  }

  setVisible(visible: boolean) {
    this.visible = visible
    if (visible) this.wake()
    else this.stop()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.model.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }

  private interactionEvent(event: Exclude<InteractionEvent, { type: 'move' }>) {
    if (!this.interactive) return
    this.driver = driverEvent(this.driver, event, this.rig.time)
    this.wake()
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault()
    this.stop()
    this.opts.onContextLost?.()
  }

  private readonly handleVisibility = () => {
    if (document.hidden) this.stop()
    else this.wake()
  }

  private canRun() {
    return !this.disposed && this.visible && !document.hidden
  }

  /** Arranca el bucle si estaba detenido. */
  private wake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    if (this.frame !== null || !this.canRun()) return
    // Con movimiento reducido el reloj del rig sigue el tiempo real aunque no se dibuje.
    if (!this.input.reducedMotion) this.last = performance.now()
    this.frame = requestAnimationFrame(this.tick)
  }

  private stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
  }

  private readonly tick = (now: number) => {
    this.frame = null
    if (!this.canRun()) return
    const cap = this.input.reducedMotion ? 60 : MAX_DT
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), cap)
    this.last = now
    this.renderFrame(dt)
    const talking = this.visemeSource?.() != null
    if (
      this.input.reducedMotion &&
      this.rig.settled &&
      !this.interactive &&
      !talking
    ) {
      // Con movimiento reducido no hace falta dibujar: se despierta solo para el próximo parpadeo.
      const wait = Math.max(this.rig.blink.nextAt - this.rig.time, 0.5)
      this.wakeTimer = setTimeout(() => this.wake(), wait * 1000)
      return
    }
    this.frame = requestAnimationFrame(this.tick)
  }

  /** Interactivo: suelta las acciones agendadas, los fidgets por ignorarlo y la siesta. */
  private effectiveInput(): RigInput {
    const viseme = this.visemeSource?.() ?? null
    const base = viseme ? { ...this.input, viseme } : this.input
    return this.interactive ? this.interactiveInput(base) : base
  }

  private interactiveInput(input: RigInput): RigInput {
    const out = releaseDue(this.driver, this.rig, {
      reducedMotion: this.input.reducedMotion,
      rng: this.rng,
    })
    this.driver = out.driver
    this.rig = out.rig
    const { drowsy, hovering } = this.driver.interaction
    const mood = drowsy && input.mood === 'idle' ? 'sleeping' : input.mood
    return { ...input, mood, hover: hovering }
  }

  private renderFrame(dt: number) {
    if (this.disposed) return
    // Primero la entrada: suelta sobre el rig las reacciones agendadas (toque,
    // roce). Leer `this.rig` antes las perdía: se avanzaba el rig de antes.
    const input = this.effectiveInput()
    const out = stepRig(this.rig, input, dt, this.rng)
    this.rig = out.state
    applyPose(this.model, out.pose, this.memory, dt)
    if (!this.input.reducedMotion) this.model.shared.uTime.value += dt
    this.renderer.render(this.scene, this.camera)
    if (!this.firstFrameSent) {
      this.firstFrameSent = true
      this.opts.onFirstFrame?.()
    }
  }
}
