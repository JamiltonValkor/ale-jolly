import { ARM } from './arm-poses'
import { FIDGET_BUILDERS, FIDGET_DURATION } from './companion-fidgets'
import type { CompanionAction, PointDirection } from './companion-moods'
import {
  addInto,
  armOffsets,
  envelope,
  offsets,
  track,
  ZERO_OFFSETS,
  type PoseOffsets,
} from './pose-offsets'

/**
 * Acciones puntuales (`ref.play`). Cada una es una actuación corta con
 * anticipación, acción y recuperación; empieza y termina en reposo, así que
 * se mezcla con cualquier ánimo sin saltos.
 */

export interface ActionOptions {
  direction?: PointDirection
}

export interface ActiveAction {
  kind: CompanionAction
  startedAt: number
  direction: PointDirection
  /** Solo el giro (lo usa el festejo para girar en el aire sin otro salto). */
  yawOnly?: boolean
}

export const ACTION_DURATION: Record<CompanionAction, number> = {
  wave: 2.4,
  nod: 1.0,
  shake: 1.25,
  jump: 1.05,
  spin: 1.45,
  surprised: 1.4,
  giggle: 1.5,
  present: 2.0,
  sigh: 1.9,
  hello: 1.7,
  ...FIDGET_DURATION,
}

/** Con movimiento reducido solo se permiten estas (sin saltos ni giros). */
const CALM = new Set<CompanionAction>([
  'wave',
  'nod',
  'shake',
  'present',
  'sigh',
  'hello',
  'lookAround',
  'lookAtHand',
])

export function isCalmAction(kind: CompanionAction): boolean {
  return CALM.has(kind)
}

function wave(t: number): PoseOffsets {
  const e = envelope(t, ACTION_DURATION.wave, 0.35, 0.45)
  // Tres saludos: la mano va y viene tres veces.
  const wag = Math.sin(Math.max(0, t - 0.35) * Math.PI * 2 * 1.75)
  return offsets({
    armRaiseR: e * (2.2 + 0.34 * wag),
    armSwingR: e * 0.25,
    headRoll: -0.1 * e,
    bodyRoll: -0.035 * e,
    smile: 0.35 * e,
    mouthOpen: 0.12 * e,
    eyeScale: 0.05 * e,
  })
}

function nod(t: number): PoseOffsets {
  const x = Math.min(Math.max(t / ACTION_DURATION.nod, 0), 1)
  const dip = Math.sin(x * Math.PI * 2) ** 2
  return offsets({
    headPitch: 0.2 * dip * (1 - x * 0.45),
    eyeOpen: -0.12 * dip,
    smile: 0.15 * Math.sin(x * Math.PI),
  })
}

function shake(t: number): PoseOffsets {
  const e = envelope(t, ACTION_DURATION.shake, 0.15, 0.3)
  return offsets({
    headYaw: 0.27 * Math.sin(t * Math.PI * 2 * 2.6) * e,
    gazeX: -0.25 * Math.sin(t * Math.PI * 2 * 2.6) * e,
    smile: -0.25 * e,
    eyeOpen: -0.15 * e,
  })
}

function hop(t: number, height: number, start: number, air: number): number {
  const u = (t - start) / air
  return u > 0 && u < 1 ? height * 4 * u * (1 - u) : 0
}

function jump(t: number): PoseOffsets {
  const arms = track(
    [
      [0, 0],
      [0.14, -0.15],
      [0.32, 0.95],
      [0.62, 0.35],
      [1.05, 0],
    ],
    t
  )
  const happy = envelope(t, ACTION_DURATION.jump, 0.15, 0.3)
  return offsets({
    rootY: hop(t, 0.34, 0.2, 0.42),
    squash: track(
      [
        [0, 0],
        [0.14, -0.14],
        [0.24, 0.1],
        [0.4, 0.02],
        [0.6, 0.05],
        [0.68, -0.12],
        [0.84, 0.035],
        [1.05, 0],
      ],
      t
    ),
    armRaiseL: arms,
    armRaiseR: arms,
    eyeOpen: -happy,
    lidCurve: happy,
    smile: 0.35 * happy,
  })
}

function spin(t: number): PoseOffsets {
  return offsets({
    rootY: hop(t, 0.2, 0.22, 0.75),
    bodyYaw: track(
      [
        [0, 0],
        [0.24, -0.15],
        [1.0, Math.PI * 2],
      ],
      t
    ),
    squash: track(
      [
        [0, 0],
        [0.18, -0.12],
        [0.3, 0.09],
        [0.9, 0.03],
        [1.02, -0.1],
        [1.2, 0.03],
        [1.45, 0],
      ],
      t
    ),
    armRaiseL: 1.2 * envelope(t, 1.25, 0.3, 0.35),
    armRaiseR: 1.2 * envelope(t, 1.25, 0.3, 0.35),
    eyeOpen: -envelope(t, 1.3, 0.25, 0.3),
    lidCurve: envelope(t, 1.3, 0.25, 0.3),
  })
}

function surprised(t: number): PoseOffsets {
  const shock = track(
    [
      [0, 0],
      [0.12, 1],
      [0.7, 1],
      [1.4, 0],
    ],
    t
  )
  return offsets({
    rootZ:
      -0.13 *
      track(
        [
          [0, 0],
          [0.16, 1],
          [0.8, 0.8],
          [1.4, 0],
        ],
        t
      ),
    rootY: hop(t, 0.12, 0.02, 0.3),
    squash: track(
      [
        [0, 0],
        [0.08, 0.1],
        [0.3, -0.07],
        [0.45, 0.02],
        [0.6, 0],
      ],
      t
    ),
    armRaiseL: 0.75 * shock,
    armRaiseR: 0.75 * shock,
    armSwingL: 0.35 * shock,
    armSwingR: 0.35 * shock,
    headPitch: -0.1 * shock,
    eyeScale: 0.3 * shock,
    mouthRound: shock,
    mouthOpen: 0.55 * shock,
  })
}

function giggle(t: number): PoseOffsets {
  const e = envelope(t, ACTION_DURATION.giggle, 0.2, 0.4)
  return offsets({
    bodyRoll: 0.045 * Math.sin(t * Math.PI * 2 * 7) * e,
    rootY: 0.018 * Math.abs(Math.sin(t * Math.PI * 2 * 3.5)) * e,
    headRoll: 0.08 * e,
    ...armOffsets('L', ARM.belly, e),
    ...armOffsets('R', ARM.belly, e),
    eyeOpen: -e,
    lidCurve: 1.1 * e,
    smile: 0.45 * e,
    mouthOpen: 0.3 * e,
    blush: 0.45 * e,
  })
}

function present(t: number, dir: PointDirection): PoseOffsets {
  const e = envelope(t, ACTION_DURATION.present, 0.4, 0.45)
  const flourish =
    Math.sin(Math.min(t, 0.8) * Math.PI * 2.5) *
    0.15 *
    (1 - Math.min(t / 0.8, 1))
  return offsets({
    ...armOffsets(
      dir === 1 ? 'R' : 'L',
      { ...ARM.present, raise: ARM.present.raise + flourish },
      e
    ),
    headYaw: 0.3 * dir * e,
    gazeX: 0.85 * dir * e,
    bodyYaw: 0.14 * dir * e,
    smile: 0.25 * e,
  })
}

function sigh(t: number): PoseOffsets {
  const inhale = track(
    [
      [0, 0],
      [0.55, 1],
      [0.7, 1],
      [1.5, 0],
    ],
    t
  )
  const exhale = track(
    [
      [0, 0],
      [0.6, 0],
      [1.2, 1],
      [1.9, 0],
    ],
    t
  )
  return offsets({
    squash: 0.05 * inhale - 0.07 * exhale,
    armRaiseL: 0.18 * inhale - 0.1 * exhale,
    armRaiseR: 0.18 * inhale - 0.1 * exhale,
    headPitch: -0.06 * inhale + 0.13 * exhale,
    eyeOpen: -0.45 * exhale,
    mouthRound: 0.6 * exhale,
    mouthOpen: 0.18 * exhale,
  })
}

/** Al rozarlo: ladea la cabeza, se acerca apenas y sonríe. Suave a propósito. */
function hello(t: number): PoseOffsets {
  const e = envelope(t, ACTION_DURATION.hello, 0.5, 0.75)
  return offsets({
    headRoll: 0.12 * e,
    bodyPitch: 0.035 * e,
    smile: 0.3 * e,
    blush: 0.2 * e,
    eyeOpen: -0.08 * e,
  })
}

const GESTURES: Record<
  string,
  (t: number, dir: PointDirection) => PoseOffsets
> = {
  wave,
  nod,
  shake,
  jump,
  spin,
  surprised,
  giggle,
  present,
  sigh,
  hello,
}

export function actionOffsets(
  kind: CompanionAction,
  elapsed: number,
  direction: PointDirection = 1,
  yawOnly = false
): PoseOffsets {
  if (elapsed <= 0 || elapsed >= ACTION_DURATION[kind]) return ZERO_OFFSETS
  if (kind === 'spin' && yawOnly) {
    return offsets({
      bodyYaw: track(
        [
          [0, 0],
          [0.62, Math.PI * 2],
        ],
        elapsed
      ),
    })
  }
  const gesture = GESTURES[kind]
  if (gesture) return gesture(elapsed, direction)
  return FIDGET_BUILDERS[kind as keyof typeof FIDGET_BUILDERS](elapsed)
}

export function isActionActive(a: ActiveAction, now: number): boolean {
  return now - a.startedAt < ACTION_DURATION[a.kind]
}

/** Suma las acciones activas en `acc` (en el lugar). */
export function addActions(
  acc: PoseOffsets,
  actions: readonly ActiveAction[],
  now: number
): PoseOffsets {
  for (const a of actions) {
    addInto(
      acc,
      actionOffsets(a.kind, now - a.startedAt, a.direction, a.yawOnly)
    )
  }
  acc.awake = Math.min(acc.awake, 1)
  return acc
}
