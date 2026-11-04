import { ARM } from './arm-poses'
import type { PointDirection } from './companion-moods'
import {
  armOffsets,
  bump,
  envelope,
  offsets,
  osc,
  track,
  type PoseOffsets,
} from './pose-offsets'

/** Actuaciones en bucle: bailar, trabajar, timidez, preocupación, confusión, presentar. */

export interface PerformanceContext {
  direction: PointDirection
  /** 0–1: energía de la voz (boca) mientras habla. */
  talk: number
}

/** Baile a 120 bpm: vaivén, rebote en cada tiempo, brazos y pies alternados. */
export function dancing(t: number): PoseOffsets {
  const bounce = 0.5 - 0.5 * Math.cos((t / 0.5) * Math.PI * 2)
  const side = osc(t, 1.0)
  const arms = osc(t, 2.0)
  return offsets({
    rootX: 0.075 * side,
    rootY: 0.045 * bounce,
    squash: -0.05 * (1 - bounce) + 0.02,
    bodyRoll: 0.085 * side,
    headRoll: -0.1 * side,
    headPitch: 0.05 * osc(t, 0.5),
    armRaiseL: 0.25 + 1.45 * Math.max(0, arms),
    armRaiseR: 0.25 + 1.45 * Math.max(0, -arms),
    armSwingL: 0.25 * Math.max(0, arms),
    armSwingR: 0.25 * Math.max(0, -arms),
    footLiftL: 0.05 * Math.max(0, side),
    footLiftR: 0.05 * Math.max(0, -side),
    gazeX: 0.3 * osc(t, 2.0),
  })
}

/** Trabajando: mira abajo y teclea con ráfagas y pausas para pensar. */
export function working(t: number): PoseOffsets {
  const burst = 1 - bump(t, 3.2, 0.85)
  const tap = Math.sin(t * Math.PI * 2 * 5.5)
  return offsets({
    ...armOffsets('L', ARM.typing),
    ...armOffsets('R', ARM.typing),
    armSwingL: ARM.typing.swing + 0.14 * Math.max(0, tap) * burst,
    armSwingR: ARM.typing.swing + 0.14 * Math.max(0, -tap) * burst,
    headPitch: 0.18 + 0.015 * Math.abs(tap) * burst,
    headYaw: 0.05 * osc(t, 6.4),
    gazeX: 0.25 * osc(t, 1.6) * burst,
    bodyPitch: 0.03,
  })
}

/** Tímido: se tapa la cara, se asoma por un lado y se mece. */
export function shy(t: number): PoseOffsets {
  const peek = bump(t, 3.6, 1.5)
  const hidden = 1 - peek
  return offsets({
    ...armOffsets('L', ARM.cheek),
    ...armOffsets('R', ARM.cheek, 1 - peek * 0.8),
    eyeOpen: -hidden,
    lidCurve: hidden,
    gazeX: 0.45 * peek,
    gazeY: 0.2 * peek,
    blush: 0.5,
    bodyRoll: 0.05 * osc(t, 2.4),
    bodyYaw: 0.1 * osc(t, 2.4, 0.6),
    headRoll: 0.08 + 0.04 * osc(t, 2.4, 1.2),
    headPitch: 0.06 * hidden,
  })
}

/** Preocupado: postura caída, mira abajo y suspira (se desinfla y se recupera). */
export function worried(t: number): PoseOffsets {
  const s = t % 4.6
  const inhale = track(
    [
      [0, 0],
      [0.6, 1],
      [0.75, 1],
      [1.5, 0],
    ],
    s
  )
  const exhale = track(
    [
      [0, 0],
      [0.65, 0],
      [1.25, 1],
      [2.1, 0],
    ],
    s
  )
  return offsets({
    ...armOffsets('L', ARM.belly, 0.7),
    ...armOffsets('R', ARM.belly, 0.7),
    armRaiseL: ARM.belly.raise * 0.7 + 0.04 * osc(t, 1.1),
    armRaiseR: ARM.belly.raise * 0.7 - 0.04 * osc(t, 1.1),
    squash: -0.035 + 0.045 * inhale - 0.06 * exhale,
    headPitch: 0.15 - 0.06 * inhale + 0.08 * exhale,
    headRoll: 0.04 * osc(t, 7.1),
    eyeOpen: -0.35 * exhale,
    mouthRound: 0.5 * exhale,
    mouthOpen: 0.12 * exhale,
  })
}

/** Confundido / error: se rasca la cabeza, ladea la cabeza y se encoge de hombros. */
export function confused(t: number): PoseOffsets {
  const s = t % 4.4
  const scratch = envelope(s, 1.9, 0.4, 0.4)
  const shrug = envelope(s - 2.0, 1.3, 0.3, 0.45)
  const rub = Math.sin(t * 44) * 0.07 * scratch
  return offsets({
    ...armOffsets(
      'R',
      { ...ARM.headSide, raise: ARM.headSide.raise + rub },
      scratch
    ),
    armRaiseL: ARM.shrug.raise * shrug,
    armSwingL: ARM.shrug.swing * shrug,
    armRaiseR: (ARM.headSide.raise + rub) * scratch + ARM.shrug.raise * shrug,
    armSwingR: ARM.headSide.swing * scratch + ARM.shrug.swing * shrug,
    headRoll: 0.2 * scratch + 0.14 * shrug,
    headYaw: -0.08 * scratch,
    squash: -0.035 * shrug,
    eyeOpenL: -0.15,
    smile: -0.1 * shrug,
  })
}

/** Presentando: brazo y mirada hacia un lado; de vez en cuando te mira a ti. */
export function presenting(t: number, ctx: PerformanceContext): PoseOffsets {
  const d = ctx.direction
  const glance = bump(t, 4.2, 1.2)
  const beat = 0.12 * bump(t, 2.6, 0.6)
  return offsets({
    ...armOffsets(d === 1 ? 'R' : 'L', {
      ...ARM.present,
      raise: ARM.present.raise + beat,
    }),
    ...armOffsets(d === 1 ? 'L' : 'R', ARM.belly, 0.35),
    headYaw: 0.3 * d * (1 - glance * 0.8),
    headRoll: -0.05 * d,
    gazeX: 0.85 * d * (1 - glance),
    bodyYaw: 0.12 * d,
    bodyRoll: 0.02 * osc(t, 5.3),
  })
}
