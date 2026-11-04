/**
 * Estados persistentes (`mood`) y acciones puntuales (`play`) del compañero.
 * Cada ánimo define su pose base; el rig la alcanza con resortes y encima
 * suma la actuación en bucle del ánimo (performances.ts).
 */

export const COMPANION_MOODS = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'celebrating',
  'sleeping',
  'syncing',
  'dancing',
  'working',
  'shy',
  'worried',
  'confused',
  'presenting',
] as const

export type CompanionMood = (typeof COMPANION_MOODS)[number]

export const COMPANION_FIDGETS = [
  'lookAtHand',
  'tinyHop',
  'stretch',
  'lookAround',
  'scratch',
  'shiftFeet',
  'yawn',
] as const

export type CompanionFidget = (typeof COMPANION_FIDGETS)[number]

export const COMPANION_ACTIONS = [
  'wave',
  'nod',
  'shake',
  'jump',
  'spin',
  'surprised',
  'giggle',
  'wake',
  'present',
  'sigh',
  'hello',
  ...COMPANION_FIDGETS,
] as const

export type CompanionAction = (typeof COMPANION_ACTIONS)[number]

/** Hacia dónde señala al presentar: −1 izquierda, 1 derecha (de la pantalla). */
export type PointDirection = -1 | 1

export function isCompanionMood(value: unknown): value is CompanionMood {
  return (
    typeof value === 'string' &&
    (COMPANION_MOODS as readonly string[]).includes(value)
  )
}

export function isCompanionAction(value: unknown): value is CompanionAction {
  return (
    typeof value === 'string' &&
    (COMPANION_ACTIONS as readonly string[]).includes(value)
  )
}

export interface MoodPreset {
  eyeOpen: number
  eyeScale: number
  /** Curva del párpado cerrado: +1 arco feliz (^ ^), −1 párpado relajado. */
  lidCurve: number
  /** 0–1: párpado inferior que sube (mirada concentrada). */
  focus: number
  /** Negativo = boca triste. */
  smile: number
  mouthOpen: number
  mouthWidth: number
  blush: number
  gazeX: number
  gazeY: number
  lean: number
  tilt: number
  breathRate: number
  breathAmp: number
  swayAmp: number
  swayRate: number
  hopAmp: number
  hopRate: number
  armLift: number
  armFlap: number
  iridescence: number
  syncWave: number
  /** Escala de la «vida» en reposo (micro movimientos con ruido). */
  life: number
  blink: boolean
  lookAround: boolean
  saccades: boolean
  fidgets: boolean
  followPointer: boolean
  talks: boolean
}

const BASE: MoodPreset = {
  eyeOpen: 1,
  eyeScale: 1,
  lidCurve: 0,
  focus: 0,
  smile: 0.6,
  mouthOpen: 0,
  mouthWidth: 1,
  blush: 0.8,
  gazeX: 0,
  gazeY: 0,
  lean: 0,
  tilt: 0,
  breathRate: 0.24,
  breathAmp: 0.024,
  swayAmp: 0.022,
  swayRate: 0.09,
  hopAmp: 0,
  hopRate: 1.4,
  armLift: 0,
  armFlap: 0,
  iridescence: 0,
  syncWave: 0,
  life: 1,
  blink: true,
  lookAround: true,
  saccades: true,
  fidgets: true,
  followPointer: true,
  talks: false,
}

/** Lo que casi todos los ánimos activos apagan del reposo. */
const BUSY = { lookAround: false, fidgets: false, saccades: false } as const

const PRESETS: Record<CompanionMood, MoodPreset> = {
  idle: BASE,
  listening: {
    ...BASE,
    ...BUSY,
    saccades: true,
    eyeScale: 1.13,
    smile: 0.5,
    blush: 0.9,
    lean: 0.11,
    tilt: 0.07,
    breathRate: 0.28,
    life: 0.6,
  },
  thinking: {
    ...BASE,
    ...BUSY,
    eyeScale: 0.96,
    focus: 0.25,
    smile: 0.22,
    mouthWidth: 0.72,
    gazeX: 0.55,
    gazeY: 0.62,
    lean: -0.03,
    tilt: -0.09,
    followPointer: false,
    life: 0.5,
  },
  speaking: {
    ...BASE,
    ...BUSY,
    saccades: true,
    eyeScale: 1.04,
    smile: 0.55,
    breathRate: 0.3,
    life: 0.5,
    talks: true,
  },
  happy: {
    ...BASE,
    ...BUSY,
    eyeOpen: 0,
    lidCurve: 1,
    smile: 1,
    mouthOpen: 0.18,
    blush: 1,
    hopAmp: 0.08,
    hopRate: 1.5,
    armLift: 0.2,
    iridescence: 0.4,
    life: 0.4,
  },
  celebrating: {
    ...BASE,
    ...BUSY,
    eyeOpen: 0,
    lidCurve: 1,
    smile: 1,
    mouthOpen: 0.62,
    blush: 1,
    iridescence: 1,
    followPointer: false,
    life: 0,
  },
  sleeping: {
    ...BASE,
    ...BUSY,
    eyeOpen: 0,
    lidCurve: -1,
    smile: 0.3,
    mouthWidth: 0.8,
    blush: 0.6,
    lean: 0.07,
    tilt: 0.13,
    breathRate: 0.16,
    breathAmp: 0.036,
    swayAmp: 0.008,
    blink: false,
    followPointer: false,
    life: 0.25,
  },
  syncing: {
    ...BASE,
    ...BUSY,
    eyeOpen: 0,
    lidCurve: 0.1,
    smile: 0.32,
    mouthWidth: 0.85,
    lean: 0.02,
    breathRate: 0.3,
    swayAmp: 0.008,
    iridescence: 0.9,
    syncWave: 1,
    blink: false,
    followPointer: false,
    life: 0.3,
  },
  dancing: {
    ...BASE,
    ...BUSY,
    smile: 1,
    mouthOpen: 0.32,
    blush: 0.95,
    followPointer: false,
    swayAmp: 0,
    life: 0,
  },
  working: {
    ...BASE,
    ...BUSY,
    eyeScale: 0.94,
    focus: 0.35,
    smile: 0.32,
    gazeY: -0.6,
    lean: 0.08,
    followPointer: false,
    life: 0.4,
  },
  shy: {
    ...BASE,
    ...BUSY,
    eyeScale: 1.05,
    smile: 0.7,
    blush: 1,
    gazeX: -0.25,
    gazeY: -0.3,
    followPointer: false,
    life: 0.5,
  },
  worried: {
    ...BASE,
    ...BUSY,
    eyeScale: 0.93,
    smile: -0.4,
    mouthWidth: 0.8,
    blush: 0.45,
    gazeY: -0.45,
    lean: 0.09,
    breathRate: 0.2,
    followPointer: false,
    life: 0.6,
  },
  confused: {
    ...BASE,
    ...BUSY,
    smile: 0.05,
    mouthWidth: 0.62,
    gazeX: 0.3,
    gazeY: 0.3,
    followPointer: false,
    life: 0.5,
  },
  presenting: {
    ...BASE,
    ...BUSY,
    smile: 0.85,
    blush: 0.85,
    followPointer: false,
    life: 0.4,
  },
}

export function moodPreset(mood: CompanionMood): MoodPreset {
  return PRESETS[mood]
}
