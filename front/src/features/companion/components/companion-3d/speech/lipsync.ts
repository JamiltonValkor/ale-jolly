/**
 * Lip-sync sin DOM: texto (español/inglés) → línea de tiempo de visemas
 * `{t, open, round, wide}`. La usan la cara 3D y la cara 2D del robot.
 *
 *   a abierta y ancha · e media y ancha · i chica y ancha · o redonda y abierta
 *   u redonda y chica · m/b/p cierran · f/v labio inferior · s/t/d/n apenas abren
 *   espacio y puntuación = pausas cerradas (cortas o largas)
 */

export interface VisemeShape {
  open: number
  round: number
  wide: number
}

export interface Viseme extends VisemeShape {
  t: number
}

export interface VisemeTimeline {
  keys: Viseme[]
  duration: number
  /** Momento (s) en que empieza cada carácter del texto original. */
  charTimes: number[]
  /** Inicio de cada palabra (para resincronizar con los eventos `boundary`). */
  words: { charIndex: number; t: number }[]
}

export const CLOSED: VisemeShape = { open: 0, round: 0, wide: 0.2 }

const V = (open: number, round: number, wide: number): VisemeShape => ({
  open,
  round,
  wide,
})

const SHAPES: Record<string, VisemeShape> = {
  a: V(0.85, 0, 0.6),
  e: V(0.5, 0, 0.75),
  i: V(0.24, 0, 0.9),
  y: V(0.24, 0, 0.8),
  o: V(0.6, 0.85, 0.1),
  u: V(0.28, 1, 0),
  w: V(0.25, 0.85, 0),
  m: V(0, 0, 0.25),
  b: V(0, 0, 0.2),
  p: V(0, 0, 0.2),
  f: V(0.1, 0, 0.35),
  v: V(0.1, 0, 0.35),
  s: V(0.18, 0, 0.55),
  z: V(0.18, 0, 0.5),
  c: V(0.22, 0, 0.45),
  t: V(0.2, 0, 0.45),
  d: V(0.22, 0, 0.45),
  n: V(0.2, 0, 0.45),
  l: V(0.25, 0, 0.45),
  r: V(0.25, 0, 0.4),
  x: V(0.22, 0, 0.45),
  k: V(0.3, 0, 0.3),
  g: V(0.3, 0, 0.3),
  j: V(0.3, 0, 0.35),
  q: V(0.3, 0.2, 0.2),
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y'])

export type CharKind =
  | VisemeShape
  | 'space'
  | 'pause'
  | 'stop'
  | 'silent'
  | null

/** Normaliza (minúsculas, sin tildes: á→a, ñ→n) y clasifica un carácter. */
export function visemeForChar(ch: string): CharKind {
  const c = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (c === '') return null
  if (/\s/.test(c)) return c === '\n' ? 'pause' : 'space'
  if (/[,;:]/.test(c)) return 'pause'
  if (/[.!?…]/.test(c)) return 'stop'
  if (c === 'h') return 'silent'
  if (/[0-9]/.test(c)) return V(0.45, 0, 0.5)
  return SHAPES[c] ?? null
}

/** Duración de cada clase, en «unidades» de 1/cps. */
function unitsFor(kind: CharKind, c: string): number {
  if (kind === null || kind === 'silent') return 0.25
  if (kind === 'space') return 0.95
  if (kind === 'pause') return 3.2
  if (kind === 'stop') return 5.5
  return VOWELS.has(c) ? 1.2 : kind.open === 0 ? 0.95 : 0.85
}

const SPACE_SHAPE: VisemeShape = { open: 0.05, round: 0, wide: 0.25 }

export function buildVisemeTimeline(
  text: string,
  opts: { charsPerSecond?: number } = {}
): VisemeTimeline {
  const unit = 1 / (opts.charsPerSecond ?? 13)
  const keys: Viseme[] = [{ t: 0, ...CLOSED }]
  const charTimes: number[] = []
  const words: { charIndex: number; t: number }[] = []
  let t = 0.04
  let prevWasLetter = false
  for (let i = 0; i < text.length; i++) {
    const kind = visemeForChar(text[i])
    const base = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    const d = unitsFor(kind, base) * unit
    charTimes.push(t)
    const isLetter = typeof kind === 'object' && kind !== null
    if ((isLetter || kind === 'silent') && !prevWasLetter)
      words.push({ charIndex: i, t })
    prevWasLetter = isLetter || kind === 'silent'
    if (isLetter) keys.push({ t: t + d / 2, ...kind })
    else if (kind === 'space') keys.push({ t: t + d / 2, ...SPACE_SHAPE })
    else if (kind === 'pause' || kind === 'stop')
      keys.push({ t: t + d * 0.25, ...CLOSED }, { t: t + d * 0.75, ...CLOSED })
    t += d
  }
  const duration = words.length ? t + 0.08 : 0
  keys.push({ t: Math.max(duration, 0.001), ...CLOSED })
  return { keys, duration, charTimes, words }
}

const smooth01 = (x: number) => x * x * (3 - 2 * x)

function interpolate(keys: Viseme[], t: number): VisemeShape {
  if (t <= keys[0].t) return CLOSED
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1]
      const b = keys[i]
      const x = smooth01((t - a.t) / Math.max(b.t - a.t, 1e-6))
      return {
        open: a.open + (b.open - a.open) * x,
        round: a.round + (b.round - a.round) * x,
        wide: a.wide + (b.wide - a.wide) * x,
      }
    }
  }
  return CLOSED
}

/** Visema en el tiempo t, con coarticulación (cada sonido se funde con sus vecinos). */
export function sampleVisemes(tl: VisemeTimeline, t: number): VisemeShape {
  if (tl.duration <= 0 || t <= 0 || t >= tl.duration) return CLOSED
  const w = 0.03
  const c = interpolate(tl.keys, t)
  const before = interpolate(tl.keys, t - w)
  const after = interpolate(tl.keys, t + w)
  return {
    open: c.open * 0.6 + (before.open + after.open) * 0.2,
    round: c.round * 0.5 + before.round * 0.2 + after.round * 0.3,
    wide: c.wide * 0.6 + (before.wide + after.wide) * 0.2,
  }
}

/** Momento de un carácter (para resincronizar con `SpeechSynthesisUtterance.onboundary`). */
export function timeForChar(tl: VisemeTimeline, charIndex: number): number {
  if (charIndex <= 0 || tl.charTimes.length === 0) return tl.charTimes[0] ?? 0
  if (charIndex >= tl.charTimes.length) return tl.duration
  return tl.charTimes[charIndex]
}
