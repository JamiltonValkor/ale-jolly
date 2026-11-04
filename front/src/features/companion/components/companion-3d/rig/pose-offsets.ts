/**
 * Vocabulario común de la animación: desplazamientos aditivos sobre la pose
 * base. Las actuaciones de cada ánimo, las acciones y la «vida» en reposo
 * devuelven estos valores; el rig los suma con pesos, así todo se mezcla
 * suave con todo.
 */

export const OFFSET_KEYS = [
  'rootX',
  'rootY',
  'rootZ',
  'squash',
  'bodyPitch',
  'bodyRoll',
  'bodyYaw',
  'headYaw',
  'headPitch',
  'headRoll',
  'armRaiseL',
  'armSwingL',
  'armReachL',
  'armRaiseR',
  'armSwingR',
  'armReachR',
  'footLiftL',
  'footLiftR',
  'eyeOpen',
  'eyeOpenL',
  'eyeOpenR',
  'eyeScale',
  'lidCurve',
  'focus',
  'gazeX',
  'gazeY',
  'smile',
  'mouthOpen',
  'mouthRound',
  'blush',
  'iridescence',
  'awake',
] as const

export type OffsetKey = (typeof OFFSET_KEYS)[number]
export type PoseOffsets = Record<OffsetKey, number>

export const ZERO_OFFSETS: Readonly<PoseOffsets> = Object.freeze(
  Object.fromEntries(OFFSET_KEYS.map(k => [k, 0])) as PoseOffsets
)

export function offsets(partial: Partial<PoseOffsets>): PoseOffsets {
  return { ...ZERO_OFFSETS, ...partial }
}

/** acc += o · w (en el lugar, sin asignar objetos por frame). */
export function addInto(
  acc: PoseOffsets,
  o: Readonly<PoseOffsets>,
  w = 1
): PoseOffsets {
  for (const k of OFFSET_KEYS) acc[k] += o[k] * w
  return acc
}

export type Key = readonly [time: number, value: number]

const smooth01 = (x: number) => x * x * (3 - 2 * x)

/** Fotogramas clave con suavizado (velocidad 0 en cada clave). */
export function track(keys: readonly Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      return v0 + (v1 - v0) * smooth01((t - t0) / (t1 - t0))
    }
  }
  return keys[keys.length - 1][1]
}

/** Sube en `rise`, se mantiene y baja en `fall` hasta `total`. */
export function envelope(
  t: number,
  total: number,
  rise: number,
  fall: number
): number {
  if (t <= 0 || t >= total) return 0
  if (t < rise) return smooth01(t / rise)
  if (t > total - fall) return smooth01((total - t) / fall)
  return 1
}

/** Pulso periódico suave: sube y baja dentro de `width` segundos cada `period`. */
export function bump(t: number, period: number, width: number): number {
  const local = ((t % period) + period) % period
  if (local >= width) return 0
  return Math.sin((local / width) * Math.PI) ** 2
}

export function osc(t: number, period: number, phase = 0): number {
  return Math.sin((t / period) * Math.PI * 2 + phase)
}

export interface ArmPose {
  raise: number
  swing: number
  reach: number
}

/** Pose de un brazo (L/R de la pantalla) con peso, como desplazamientos parciales. */
export function armOffsets(
  side: 'L' | 'R',
  pose: ArmPose,
  w = 1
): Partial<PoseOffsets> {
  return side === 'L'
    ? {
        armRaiseL: pose.raise * w,
        armSwingL: pose.swing * w,
        armReachL: pose.reach * w,
      }
    : {
        armRaiseR: pose.raise * w,
        armSwingR: pose.swing * w,
        armReachR: pose.reach * w,
      }
}
