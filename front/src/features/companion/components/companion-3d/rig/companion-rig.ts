import { createBlinkState, stepBlink, type BlinkState } from './blink'
import {
  addActions,
  isActionActive,
  type ActiveAction,
} from './companion-actions'
import {
  moodPreset,
  type CompanionAction,
  type CompanionMood,
  type MoodPreset,
  type PointDirection,
} from './companion-moods'
import {
  createFidgetState,
  forceFidget,
  stepFidget,
  type FidgetState,
} from './fidget-scheduler'
import {
  breathJitter,
  createSaccade,
  idleLife,
  saccadeGaze,
  stepSaccade,
  type Saccade,
} from './idle-life'
import { cuesBetween, performanceOffsets, STATIC_TIME } from './performances'
import { addInto, offsets, type PoseOffsets } from './pose-offsets'
import type { Rng } from './random'
import type { VisemeShape } from '../speech/lipsync'
import {
  channelValues,
  createChannels,
  presetTargets,
  stepChannels,
  type Channels,
  type Targets,
} from './rig-channels'

/**
 * Rig del compañero (lógica pura, sin three). Capas que se suman:
 * pose base con resortes → actuación en bucle del ánimo (mezcla por pesos al
 * cambiar) → acciones puntuales → «vida» en reposo con ruido → sacadas y
 * parpadeos. Determinista con un Rng inyectado.
 */

export interface RigInput {
  mood: CompanionMood
  /** 0–1. `undefined`/`null` mientras habla = patrón automático. */
  speakingLevel?: number | null
  /** Puntero relativo a la cara (≈ −1…1, y hacia arriba). */
  pointer: { x: number; y: number } | null
  reducedMotion: boolean
  /** El puntero está encima (modo interactivo): se sonroja y sonríe más. */
  hover?: boolean
  /** Lado al que presenta. */
  direction?: PointDirection
  /** Visema actual del lip-sync (`say`); `speakingLevel` numérico tiene prioridad. */
  viseme?: VisemeShape | null
}

export interface FacePose {
  eyeOpenL: number
  eyeOpenR: number
  eyeScale: number
  lidCurve: number
  focus: number
  gazeX: number
  gazeY: number
  smile: number
  mouthOpen: number
  mouthWidth: number
  mouthRound: number
  blush: number
}

export interface RigPose {
  rootX: number
  rootY: number
  rootZ: number
  squash: number
  breath: number
  bodyPitch: number
  bodyRoll: number
  bodyYaw: number
  headYaw: number
  headPitch: number
  headRoll: number
  armRaiseL: number
  armSwingL: number
  armReachL: number
  armRaiseR: number
  armSwingR: number
  armReachR: number
  footLiftL: number
  footLiftR: number
  face: FacePose
  iridescence: number
  syncWave: number
}

interface PerformanceLayer {
  mood: CompanionMood
  since: number
  weight: number
}

export interface RigState {
  time: number
  mood: CompanionMood
  channels: Channels
  phases: { breath: number; sway: number; hop: number; flap: number }
  blink: BlinkState
  saccade: Saccade
  fidget: FidgetState
  actions: ActiveAction[]
  layers: PerformanceLayer[]
  seed: number
  settled: boolean
}

const FADE = 0.7
const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi)
const ease = (w: number) => w * w * (3 - 2 * w)
const smooth = (a: number, b: number, x: number) =>
  ease(clamp((x - a) / (b - a), 0, 1))
const soft = (v: number) => v / Math.sqrt(1 + v * v * 0.6)

/** Habla automática: sílabas con pausas entre frases. */
export function autoTalk(t: number): number {
  const syllable = 0.5 + 0.5 * Math.sin(t * 13.1) * Math.sin(t * 5.3 + 1.1)
  const phrase = smooth(-0.7, -0.35, Math.sin(t * 1.07))
  return clamp(syllable * phrase * 0.88 + 0.04 * phrase, 0, 1)
}

export function createRigState(
  mood: CompanionMood,
  {
    rng,
    reducedMotion,
    now = 0,
    seed = 1,
  }: { rng: Rng; reducedMotion: boolean; now?: number; seed?: number }
): RigState {
  return {
    time: now,
    mood,
    channels: createChannels(presetTargets(moodPreset(mood), reducedMotion)),
    phases: { breath: 0, sway: 0, hop: 0, flap: 0 },
    blink: createBlinkState(now, rng, reducedMotion),
    saccade: createSaccade(now, rng),
    fidget: createFidgetState(now, rng),
    actions: [],
    layers: [{ mood, since: now, weight: 1 }],
    seed,
    settled: false,
  }
}

export interface TriggerOptions {
  direction?: PointDirection
  yawOnly?: boolean
}

export function triggerAction(
  state: RigState,
  kind: CompanionAction,
  opts: TriggerOptions = {}
): RigState {
  return {
    ...state,
    settled: false,
    fidget: {
      ...state.fidget,
      nextAt: Math.max(state.fidget.nextAt, state.time + 6),
    },
    actions: [
      ...state.actions.filter(a => a.kind !== kind),
      {
        kind,
        startedAt: state.time,
        direction: opts.direction ?? 1,
        yawOnly: opts.yawOnly,
      },
    ],
  }
}

/** Alias de la API anterior. */
export const triggerGesture = triggerAction

/** Fuerza un gesto de reposo ahora (interactivo: 20 s ignorado). */
export function triggerFidget(state: RigState, rng: Rng): RigState {
  const out = forceFidget(state.fidget, state.time, rng)
  return { ...triggerAction(state, out.fire), fidget: out.state }
}

function stepLayers(
  layers: PerformanceLayer[],
  mood: CompanionMood,
  time: number,
  dt: number
) {
  const list =
    layers[layers.length - 1]?.mood === mood
      ? layers
      : [...layers, { mood, since: time, weight: 0 }]
  const last = list.length - 1
  return list
    .map((l, i) => ({
      ...l,
      weight: clamp(l.weight + (i === last ? dt : -dt) / FADE, 0, 1),
    }))
    .filter((l, i) => i === last || l.weight > 0)
}

function applyAttention(
  targets: Targets,
  preset: MoodPreset,
  input: RigInput
): void {
  if (!preset.followPointer || input.reducedMotion || !input.pointer) return
  const px = soft(input.pointer.x)
  const py = soft(input.pointer.y)
  targets.gazeX = px
  targets.gazeY = py * 0.8
  // La capucha gira entera como una pieza rígida (hombros incluidos): un giro corto basta.
  targets.headYaw = px * 0.22
  targets.headPitch = -py * 0.12
}

/** Boca: amplitud real (`speakingLevel`) > visemas del texto > habla automática. */
function applyMouth(
  targets: Targets,
  preset: MoodPreset,
  input: RigInput,
  now: number
): void {
  const level = input.speakingLevel
  if (typeof level === 'number' && (preset.talks || input.viseme)) {
    targets.mouthOpen = clamp(level, 0, 1)
  } else if (input.viseme) {
    targets.mouthOpen = input.viseme.open
    targets.mouthRound = input.viseme.round
    targets.mouthWidth = preset.mouthWidth * (0.8 + 0.45 * input.viseme.wide)
  } else if (preset.talks) {
    targets.mouthOpen = input.reducedMotion ? 0.3 : autoTalk(now)
  }
}

function resolveTargets(input: RigInput, awake: number, now: number): Targets {
  const preset = moodPreset(input.mood)
  const targets = presetTargets(preset, input.reducedMotion)
  if (input.mood === 'sleeping' && awake > 0) {
    const idle = presetTargets(moodPreset('idle'), input.reducedMotion)
    for (const k of ['eyeOpen', 'lidCurve', 'smile', 'lean', 'tilt'] as const) {
      targets[k] += (idle[k] - targets[k]) * awake
    }
  }
  applyMouth(targets, preset, input, now)
  if (input.hover) {
    targets.blush += 0.3
    targets.smile += 0.2
  }
  applyAttention(targets, preset, input)
  return targets
}

function advancePhases(
  state: RigState,
  ch: Channels,
  dt: number
): RigState['phases'] {
  const wrap = (v: number) => v % (TAU * 1000)
  const jitter = breathJitter(state.time, state.seed)
  return {
    breath: wrap(state.phases.breath + ch.breathRate.value * jitter * dt * TAU),
    sway: wrap(state.phases.sway + ch.swayRate.value * dt * TAU),
    hop: wrap(state.phases.hop + ch.hopRate.value * dt * TAU),
    flap: wrap(state.phases.flap + 2.6 * dt * TAU),
  }
}

/** Suma de actuaciones (por peso), acciones y vida en reposo. */
function gatherOffsets(
  state: RigState,
  input: RigInput,
  talk: number,
  life: number
): PoseOffsets {
  const acc = offsets({})
  const ctx = { direction: input.direction ?? 1, talk }
  for (const layer of state.layers) {
    const t = input.reducedMotion
      ? STATIC_TIME[layer.mood]
      : state.time - layer.since
    addInto(acc, performanceOffsets(layer.mood, t, ctx), ease(layer.weight))
  }
  addActions(acc, state.actions, state.time)
  if (!input.reducedMotion) addInto(acc, idleLife(state.time, state.seed, life))
  return acc
}

function composeFace(
  v: Targets,
  o: PoseOffsets,
  blink: number,
  saccade: { x: number; y: number }
): FacePose {
  const open = clamp(v.eyeOpen + o.eyeOpen, 0, 1)
  return {
    eyeOpenL: clamp(open + o.eyeOpenL, 0, 1) * (1 - blink),
    eyeOpenR: clamp(open + o.eyeOpenR, 0, 1) * (1 - blink),
    eyeScale: v.eyeScale + o.eyeScale,
    lidCurve: clamp(v.lidCurve + o.lidCurve, -1.6, 1.6),
    focus: clamp(v.focus + o.focus, 0, 1),
    gazeX: clamp(v.gazeX + o.gazeX + saccade.x, -1, 1),
    gazeY: clamp(v.gazeY + o.gazeY + saccade.y, -1, 1),
    smile: clamp(v.smile + o.smile, -0.6, 1.2),
    mouthOpen: clamp(v.mouthOpen + o.mouthOpen, 0, 1),
    mouthWidth: v.mouthWidth,
    mouthRound: clamp(v.mouthRound + o.mouthRound, 0, 1),
    blush: clamp(v.blush + o.blush, 0, 1.3),
  }
}

function composeBody(
  v: Targets,
  o: PoseOffsets,
  state: RigState,
  input: RigInput
) {
  const { phases } = state
  const breath = v.breathAmp * Math.sin(phases.breath)
  const sway = v.swayAmp * Math.sin(phases.sway)
  const hopWave = Math.sin(phases.hop)
  const up = Math.max(0, hopWave)
  const flap = v.armFlap * Math.sin(phases.flap)
  const arm = 0.1 + v.armLift * 2 + breath * 1.4
  const grounded = input.reducedMotion && input.mood !== 'syncing'
  return {
    rootX: o.rootX,
    rootY: grounded ? 0 : v.hopAmp * up + o.rootY,
    rootZ: grounded ? 0 : o.rootZ,
    squash: 1 + o.squash + v.hopAmp * (hopWave > 0 ? up * 0.7 : hopWave * 1.3),
    breath,
    bodyPitch: v.lean * 0.55 + o.bodyPitch,
    bodyRoll: sway + v.tilt * 0.3 + o.bodyRoll,
    bodyYaw: input.reducedMotion ? 0 : o.bodyYaw,
    headYaw: v.headYaw + o.headYaw,
    headPitch: v.headPitch + v.lean * 0.5 + o.headPitch + breath * 0.8,
    headRoll: v.tilt + sway * 0.8 + o.headRoll,
    armRaiseL: arm + flap + o.armRaiseL,
    armSwingL: o.armSwingL,
    armReachL: o.armReachL,
    armRaiseR: arm - flap + o.armRaiseR,
    armSwingR: o.armSwingR,
    armReachR: o.armReachR,
    footLiftL: o.footLiftL,
    footLiftR: o.footLiftR,
  }
}

function composePose(state: RigState, input: RigInput, blink: number): RigPose {
  const v = channelValues(state.channels)
  const o = gatherOffsets(state, input, v.mouthOpen, v.life)
  const pulse = input.reducedMotion
    ? 1
    : 0.84 + 0.16 * Math.sin(state.time * 3.8)
  return {
    ...composeBody(v, o, state, input),
    face: composeFace(v, o, blink, saccadeGaze(state.saccade, state.time)),
    iridescence: Math.max(0, v.iridescence + o.iridescence) * pulse,
    syncWave: v.syncWave,
  }
}

/** Fidgets en reposo y señales de la actuación (giro de cada dos festejos). */
function scheduleExtras(
  state: RigState,
  prevTime: number,
  input: RigInput,
  rng: Rng
): RigState {
  let next = state
  const preset = moodPreset(input.mood)
  const calm = !input.reducedMotion
  const fidget = stepFidget(
    next.fidget,
    next.time,
    rng,
    preset.fidgets && calm && next.actions.length === 0
  )
  next = { ...next, fidget: fidget.state }
  if (fidget.fire)
    next = { ...triggerAction(next, fidget.fire), fidget: fidget.state }
  const layer = next.layers[next.layers.length - 1]
  if (calm) {
    for (const cue of cuesBetween(
      layer.mood,
      prevTime - layer.since,
      next.time - layer.since
    )) {
      next = triggerAction(next, cue.action, { yawOnly: true })
    }
  }
  return next
}

export function stepRig(
  prev: RigState,
  input: RigInput,
  dt: number,
  rng: Rng
): { state: RigState; pose: RigPose } {
  const time = prev.time + dt
  let actions = prev.actions.filter(a => isActionActive(a, time))
  if (
    prev.mood === 'sleeping' &&
    input.mood !== 'sleeping' &&
    !input.reducedMotion
  ) {
    actions = [
      ...actions.filter(a => a.kind !== 'wake'),
      { kind: 'wake', startedAt: time, direction: 1 },
    ]
  }
  const awake = addActions(offsets({}), actions, time).awake
  const preset = moodPreset(input.mood)
  const { channels, settled } = stepChannels(
    prev.channels,
    resolveTargets(input, awake, time),
    dt
  )
  const blink = stepBlink(prev.blink, time, rng, {
    enabled: preset.blink && (input.mood !== 'sleeping' || awake > 0.5),
    reducedMotion: input.reducedMotion,
  })
  let state: RigState = {
    ...prev,
    time,
    mood: input.mood,
    channels,
    actions,
    blink: blink.state,
    phases: advancePhases(prev, channels, dt),
    saccade: stepSaccade(
      prev.saccade,
      time,
      rng,
      preset.saccades && !input.reducedMotion
    ),
    layers: stepLayers(prev.layers, input.mood, time, dt),
  }
  state = scheduleExtras(state, prev.time, input, rng)
  const layersSettled =
    state.layers.length === 1 && state.layers[0].weight === 1
  state.settled =
    settled &&
    layersSettled &&
    state.actions.length === 0 &&
    blink.closure === 0
  return { state, pose: composePose(state, input, blink.closure) }
}
