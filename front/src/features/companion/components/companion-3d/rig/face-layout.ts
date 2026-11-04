import { moodPreset, type CompanionMood } from './companion-moods'

/**
 * Geometría de la cara, igual a la pantalla del robot: ojos negros grandes
 * y separados con brillo blanco arriba a la izquierda, rubor rosa debajo y
 * sonrisa fina. Coordenadas de cara: x ∈ [−1, 1] (medio ancho = 1), y hacia
 * arriba, alto = aspect. La usan el shader (uniformes) y el SVG de respaldo.
 */
export const FACE = {
  aspect: 0.74,
  n: 3.2,
  eye: { x: 0.46, y: 0.05, r: 0.165, stretchY: 1.06 },
  highlight: { dx: -0.34, dy: 0.36, r: 0.33 },
  highlightSmall: { dx: 0.36, dy: -0.38, r: 0.12 },
  blush: { x: 0.6, y: -0.2, rx: 0.24, ry: 0.15 },
  mouth: { y: -0.29, halfWidth: 0.2, depth: 0.07, thickness: 0.034 },
  gaze: { x: 0.11, y: 0.075 },
} as const

export function eyeCenter(
  side: -1 | 1,
  gazeX: number,
  gazeY: number
): { x: number; y: number } {
  return {
    x: side * FACE.eye.x + gazeX * FACE.gaze.x,
    y: FACE.eye.y + gazeY * FACE.gaze.y,
  }
}

export function superellipsePoint(
  angle: number,
  a: number,
  b: number,
  n: number
): { x: number; y: number } {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return {
    x: a * Math.sign(c) * Math.abs(c) ** (2 / n),
    y: b * Math.sign(s) * Math.abs(s) ** (2 / n),
  }
}

const f = (v: number) => Number(v.toFixed(2))

export function superellipsePath(
  cx: number,
  cy: number,
  a: number,
  b: number,
  n: number,
  steps: number
): string {
  const pts: string[] = []
  for (let i = 0; i < steps; i++) {
    const p = superellipsePoint((i / steps) * Math.PI * 2, a, b, n)
    pts.push(`${f(cx + p.x)} ${f(cy + p.y)}`)
  }
  return `M${pts.join(' L')} Z`
}

/** Ojo cerrado (SVG, y hacia abajo): curve > 0 arco feliz ∩, curve < 0 párpado ∪. */
export function closedEyePath(
  cx: number,
  cy: number,
  r: number,
  curve: number
): string {
  const ctrlY = cy - curve * r * 1.1
  return `M ${f(cx - r)} ${f(cy)} Q ${f(cx)} ${f(ctrlY)} ${f(cx + r)} ${f(cy)}`
}

/** Boca (SVG): línea de sonrisa o, si está abierta, una «D» rellena. */
export function mouthPath(
  cx: number,
  cy: number,
  halfWidth: number,
  smile: number,
  open: number
): { d: string; filled: boolean } {
  const dip = halfWidth * 0.36 * smile
  const l = f(cx - halfWidth)
  const r = f(cx + halfWidth)
  if (open < 0.08) {
    return {
      d: `M ${l} ${f(cy)} Q ${f(cx)} ${f(cy + dip * 2)} ${r} ${f(cy)}`,
      filled: false,
    }
  }
  const drop = halfWidth * 0.9 * open
  return {
    d: `M ${l} ${f(cy)} Q ${f(cx)} ${f(cy + dip)} ${r} ${f(cy)} Q ${f(cx)} ${f(cy + dip + drop * 2)} ${l} ${f(cy)} Z`,
    filled: true,
  }
}

export interface FallbackFace {
  eyes: 'open' | 'happy' | 'sleep'
  eyeScale: number
  gazeX: number
  gazeY: number
  smile: number
  mouthOpen: number
  blush: number
}

export function fallbackFace(mood: CompanionMood): FallbackFace {
  const p = moodPreset(mood)
  const eyes = p.eyeOpen > 0.5 ? 'open' : p.lidCurve > 0 ? 'happy' : 'sleep'
  return {
    eyes,
    eyeScale: p.eyeScale,
    gazeX: p.gazeX,
    gazeY: p.gazeY,
    smile: p.smile,
    mouthOpen: p.talks ? 0.3 : p.mouthOpen,
    blush: p.blush,
  }
}
