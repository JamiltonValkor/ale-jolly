import type { FaceState } from '../../lib/face-state'

/**
 * Geometría de la cara del compañero (la del robot de Jamilton, refinada):
 * ojos negros grandes con brillo blanco, rubor rosa difuso y sonrisa fina.
 * Todo en un viewBox 3:2; la variante «placa» recorta un cuadrado centrado.
 */

export const FACE_VIEWBOX = { width: 240, height: 160 } as const
/** Recorte cuadrado para la placa (tarjetas, avatar). */
export const PLATE_VIEWBOX = '18 -16 204 204'

export const EYE = { leftX: 60, rightX: 180, y: 74, rx: 17.5, ry: 19 } as const
export const BLUSH = { leftX: 57, rightX: 183, y: 107, rx: 21, ry: 10.5 }
export const MOUTH = { x: 120, y: 106 } as const

export const FACE_INK = '#16120E'
export const BLUSH_COLOR = '#FF8DA6'

export interface MouthShape {
  /** Media anchura de la boca. */
  width: number
  /** Profundidad de la curva (negativa = un poco caída). */
  smile: number
  /** 0 = línea, 1 = bien abierta. */
  open: number
  offsetX?: number
  /** Inclinación: la comisura derecha baja `tilt` unidades. */
  tilt?: number
}

export type EyeShape = 'open' | 'happy' | 'closed'
export type BrowShape = 'none' | 'worried' | 'curious'

export interface FaceConfig {
  eyes: EyeShape
  eyeScale: number
  eyeScaleY: number
  gaze: { x: number; y: number }
  blush: number
  brows: BrowShape
  mouth: MouthShape
  blink: boolean
  wander: boolean
  bounce: boolean
  breathe: boolean
}

const BASE: FaceConfig = {
  eyes: 'open',
  eyeScale: 1,
  eyeScaleY: 1,
  gaze: { x: 0, y: 0 },
  blush: 0.55,
  brows: 'none',
  mouth: { width: 16.5, smile: 6, open: 0 },
  blink: true,
  wander: false,
  bounce: false,
  breathe: false,
}

export const FACE_CONFIG: Record<FaceState, FaceConfig> = {
  sleeping: {
    ...BASE,
    eyes: 'closed',
    blush: 0.38,
    mouth: { width: 9, smile: 3, open: 0 },
    blink: false,
    breathe: true,
  },
  waking: { ...BASE, mouth: { width: 11, smile: 4, open: 0.28 }, blink: false },
  idle: { ...BASE, wander: true },
  listening: {
    ...BASE,
    eyeScale: 1.12,
    gaze: { x: 0, y: -1.5 },
    blush: 0.62,
    mouth: { width: 12, smile: 5, open: 0.2 },
    bounce: true,
  },
  thinking: {
    ...BASE,
    gaze: { x: 7, y: -8 },
    brows: 'curious',
    mouth: { width: 10, smile: 1.5, open: 0, offsetX: 7, tilt: -2.5 },
    wander: true,
  },
  speaking: { ...BASE, mouth: { width: 14, smile: 5, open: 0.4 } },
  happy: {
    ...BASE,
    eyes: 'happy',
    blush: 0.82,
    mouth: { width: 18, smile: 7, open: 0.62 },
    blink: false,
    bounce: true,
  },
  syncing: {
    ...BASE,
    eyeScaleY: 0.84,
    blush: 0.45,
    mouth: { width: 9, smile: 1.5, open: 0 },
    blink: false,
  },
  error: {
    ...BASE,
    eyeScale: 0.92,
    blush: 0.42,
    brows: 'worried',
    mouth: { width: 10, smile: -2.4, open: 0.06 },
  },
}

const r = (n: number) => Math.round(n * 100) / 100

/**
 * Boca como una «lente» cerrada (curva de arriba + curva de abajo). Con
 * `open` 0 las dos curvas coinciden y el trazo redondo la dibuja como línea;
 * así todas las bocas tienen la misma estructura y se interpolan entre sí.
 */
export function mouthPath(shape: MouthShape): string {
  const cx = MOUTH.x + (shape.offsetX ?? 0)
  const tilt = shape.tilt ?? 0
  const lx = cx - shape.width
  const rx = cx + shape.width
  const ly = MOUTH.y - tilt / 2
  const ry = MOUTH.y + tilt / 2
  const top = MOUTH.y + shape.smile * 2 - shape.open * 3
  const bottom = MOUTH.y + shape.smile * 2 + shape.open * 26
  return `M${r(lx)} ${r(ly)}Q${r(cx)} ${r(top)} ${r(rx)} ${r(ry)}Q${r(cx)} ${r(bottom)} ${r(lx)} ${r(ly)}Z`
}

/**
 * Visema → boca: abrir baja el labio, redondear angosta (la «o», la «u»),
 * estirar ensancha y sube un poco las comisuras (la «i», la «e»).
 */
export function visemeToMouth(
  viseme: { open: number; round: number; wide: number },
  base: MouthShape
): MouthShape {
  return {
    ...base,
    width: base.width * (0.82 + viseme.wide * 0.32 - viseme.round * 0.38),
    smile: base.smile * (1 - viseme.round * 0.8) + viseme.wide * 1.2,
    open: Math.min(1, viseme.open * 0.95 + viseme.round * 0.12),
  }
}

/** Punto que da la vuelta a la cara mientras sincroniza (t en segundos). */
export function orbitPoint(t: number): { x: number; y: number } {
  const angle = t * 1.15 - Math.PI / 2
  return {
    x: MOUTH.x + Math.cos(angle) * 90,
    y: 86 + Math.sin(angle) * 60,
  }
}

/** Mirada hacia el punto: los ojos lo siguen sin salirse de la cara. */
export function gazeToward(point: { x: number; y: number }): {
  x: number
  y: number
} {
  const dx = point.x - MOUTH.x
  const dy = point.y - EYE.y
  const length = Math.hypot(dx, dy) || 1
  return { x: (dx / length) * 6, y: (dy / length) * 5 }
}

/** Patrón automático del habla: sílabas irregulares entre 0 y 1. */
export function speechOpenness(t: number): number {
  const syllables =
    Math.sin(t * 13.1) * 0.42 +
    Math.sin(t * 7.3 + 1.2) * 0.3 +
    Math.sin(t * 3.1 + 0.4) * 0.2
  const pauses = Math.sin(t * 1.7) > 0.82 ? 0.15 : 1
  return Math.min(1, Math.max(0, (syllables + 0.45) * pauses))
}
