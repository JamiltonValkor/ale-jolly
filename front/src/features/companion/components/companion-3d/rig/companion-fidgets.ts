import { ARM } from './arm-poses'
import type { CompanionFidget } from './companion-moods'
import {
  armOffsets,
  bump,
  envelope,
  offsets,
  track,
  type Key,
  type PoseOffsets,
} from './pose-offsets'

/**
 * Despertar y gestos de reposo («fidgets»): pequeñas cosas que hace solo
 * cuando nadie le pide nada, para que nunca se vea congelado.
 */

export const FIDGET_DURATION: Record<CompanionFidget | 'wake', number> = {
  wake: 3.4,
  lookAtHand: 2.6,
  tinyHop: 0.85,
  stretch: 2.1,
  lookAround: 2.9,
  scratch: 1.9,
  shiftFeet: 1.6,
  yawn: 2.3,
}

const WAKE: Record<string, readonly Key[]> = {
  stretch: [
    [0, 0],
    [0.25, 0.15],
    [0.8, 1],
    [1.15, 1],
    [1.45, 0],
  ],
  rub: [
    [0, 0],
    [1.3, 0],
    [1.6, 1],
    [2.25, 1],
    [2.55, 0],
  ],
  squash: [
    [0, 0],
    [0.25, -0.06],
    [0.8, 0.1],
    [1.15, 0.08],
    [1.5, -0.03],
    [1.8, 0],
  ],
  yawn: [
    [0, 0],
    [0.4, 1],
    [1.15, 0.9],
    [1.45, 0],
  ],
  squeeze: [
    [0, 0],
    [0.3, 1],
    [2.25, 1],
    [2.45, 0],
  ],
  smile: [
    [0, 0],
    [2.7, 0],
    [3.0, 0.35],
    [3.4, 0],
  ],
  awake: [
    [0, 0],
    [0.2, 1],
    [3.1, 1],
    [3.4, 0],
  ],
}

/** Estirón con bostezo, se frota los ojos, parpadea rápido y sonríe. */
function wake(t: number): PoseOffsets {
  const up = track(WAKE.stretch, t)
  const rub = track(WAKE.rub, t)
  const circle = Math.sin(t * 13) * 0.09 * rub
  const blinks = t > 2.45 && t < 2.95 ? -bump(t - 2.45, 0.17, 0.15) : 0
  return offsets({
    armRaiseL: ARM.up.raise * up * 1.05 + ARM.eyes.raise * rub,
    armSwingL: ARM.up.swing * up + (ARM.eyes.swing + circle) * rub,
    armReachL: ARM.eyes.reach * rub,
    armRaiseR: ARM.up.raise * up * 1.05 + ARM.eyes.raise * rub,
    armSwingR: ARM.up.swing * up + (ARM.eyes.swing - circle) * rub,
    armReachR: ARM.eyes.reach * rub,
    squash: track(WAKE.squash, t),
    headPitch: -0.16 * up + 0.1 * rub,
    mouthRound: track(WAKE.yawn, t),
    mouthOpen: 0.7 * track(WAKE.yawn, t),
    eyeOpen: -track(WAKE.squeeze, t) + blinks,
    lidCurve: 1.3 * track(WAKE.squeeze, t),
    smile: track(WAKE.smile, t),
    eyeScale: 0.12 * track(WAKE.smile, t),
    awake: track(WAKE.awake, t),
  })
}

function lookAtHand(t: number): PoseOffsets {
  const e = envelope(t, FIDGET_DURATION.lookAtHand, 0.55, 0.55)
  const wiggle = Math.sin(t * 15) * 0.05 * e
  return offsets({
    ...armOffsets('R', ARM.lookHand, e),
    armRaiseR: (ARM.lookHand.raise + wiggle) * e,
    headYaw: 0.26 * e,
    headPitch: 0.12 * e,
    gazeX: 0.55 * e,
    gazeY: -0.25 * e,
    eyeScale: 0.06 * e,
  })
}

function tinyHop(t: number): PoseOffsets {
  const air = t > 0.18 && t < 0.52 ? (t - 0.18) / 0.34 : -1
  return offsets({
    rootY: air >= 0 ? 0.1 * 4 * air * (1 - air) : 0,
    squash: track(
      [
        [0, 0],
        [0.14, -0.08],
        [0.24, 0.06],
        [0.52, 0.02],
        [0.6, -0.06],
        [0.85, 0],
      ],
      t
    ),
    armRaiseL: 0.35 * envelope(t, 0.85, 0.25, 0.4),
    armRaiseR: 0.35 * envelope(t, 0.85, 0.25, 0.4),
    smile: 0.2 * envelope(t, 0.85, 0.2, 0.3),
  })
}

function stretch(t: number): PoseOffsets {
  const e = envelope(t, FIDGET_DURATION.stretch, 0.7, 0.7)
  return offsets({
    ...armOffsets('L', ARM.up, e),
    ...armOffsets('R', ARM.up, e),
    squash: 0.08 * e,
    headPitch: -0.14 * e,
    eyeOpen: -e,
    lidCurve: 1.2 * e,
    smile: 0.2 * e,
  })
}

function lookAround(t: number): PoseOffsets {
  const yaw = track(
    [
      [0, 0],
      [0.5, -0.36],
      [1.1, -0.36],
      [1.6, 0.36],
      [2.3, 0.36],
      [2.9, 0],
    ],
    t
  )
  return offsets({
    headYaw: yaw,
    headRoll: -yaw * 0.25,
    gazeX: yaw * 2.2,
    gazeY: 0.15 * envelope(t, 2.9, 0.5, 0.5),
    eyeScale: 0.07 * envelope(t, 2.9, 0.4, 0.5),
  })
}

function scratch(t: number): PoseOffsets {
  const e = envelope(t, FIDGET_DURATION.scratch, 0.4, 0.45)
  const rub = Math.sin(t * 50) * 0.1 * e
  return offsets({
    armRaiseR: (-0.25 + rub) * e,
    armSwingR: -0.45 * e,
    headRoll: -0.1 * e,
    headYaw: 0.12 * e,
    focus: 0.35 * e,
    smile: -0.15 * e,
    bodyRoll: -0.03 * e,
  })
}

function shiftFeet(t: number): PoseOffsets {
  const l = bump(t, 10, 0.55)
  const r = t > 0.65 ? bump(t - 0.65, 10, 0.55) : 0
  return offsets({
    footLiftL: 0.07 * l,
    footLiftR: 0.07 * r,
    rootX: 0.035 * (r - l),
    bodyRoll: 0.035 * (l - r),
    squash: -0.02 * (l + r),
  })
}

function yawn(t: number): PoseOffsets {
  const e = envelope(t, FIDGET_DURATION.yawn, 0.5, 0.6)
  return offsets({
    mouthRound: e,
    mouthOpen: 0.75 * e,
    eyeOpen: -e,
    lidCurve: 1.1 * e,
    headPitch: -0.14 * e,
    armRaiseL: 0.3 * e,
    armRaiseR: 0.3 * e,
    squash: 0.05 * e,
  })
}

export const FIDGET_BUILDERS: Record<
  CompanionFidget | 'wake',
  (t: number) => PoseOffsets
> = {
  wake,
  lookAtHand,
  tinyHop,
  stretch,
  lookAround,
  scratch,
  shiftFeet,
  yawn,
}
