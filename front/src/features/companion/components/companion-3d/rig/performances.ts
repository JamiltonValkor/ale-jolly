import { ARM } from './arm-poses'
import type { CompanionMood } from './companion-moods'
import {
  confused,
  dancing,
  presenting,
  shy,
  working,
  worried,
  type PerformanceContext,
} from './performances-more'
import {
  armOffsets,
  bump,
  osc,
  offsets,
  track,
  ZERO_OFFSETS,
  type PoseOffsets,
} from './pose-offsets'

export type { PerformanceContext }

/**
 * Actuación en bucle de cada ánimo, en función del tiempo dentro del ánimo.
 * Son desplazamientos que el rig mezcla por pesos al cambiar de ánimo.
 */

function listening(t: number): PoseOffsets {
  return offsets({
    headPitch: 0.07 * bump(t, 2.8, 0.6),
    headRoll: 0.04 * osc(t, 5.3),
    ...armOffsets('L', ARM.belly, 0.35),
    ...armOffsets('R', ARM.belly, 0.35),
    eyeScale: 0.03 * osc(t, 3.7),
  })
}

/** Pensando: mano al mentón con golpecitos, el otro brazo en la barriga, mirada que vaga. */
function thinking(t: number): PoseOffsets {
  const tapping = bump(t, 3.5, 1.0)
  return offsets({
    ...armOffsets('R', ARM.chin),
    armSwingR: ARM.chin.swing + 0.08 * Math.sin(t * 14) * tapping,
    ...armOffsets('L', ARM.belly, 0.55),
    bodyRoll: 0.04 * osc(t, 6.5),
    headRoll: 0.05 * osc(t, 6.5, 1),
    gazeX: 0.3 * osc(t, 7.3),
    gazeY: 0.08 * osc(t, 4.1),
  })
}

/** Hablando: gestos de ritmo con las manos y la cabeza al compás de la voz. */
function speaking(t: number, ctx: PerformanceContext): PoseOffsets {
  const beatR = bump(t, 1.9, 0.55)
  const beatL = bump(t + 0.95, 2.3, 0.5)
  const energy = 0.5 + 0.5 * ctx.talk
  return offsets({
    armSwingR: 0.4 + 0.4 * beatR,
    armRaiseR: -0.15 + 0.3 * beatR,
    armSwingL: 0.3 + 0.35 * beatL,
    armRaiseL: -0.1 + 0.25 * beatL,
    headPitch: 0.045 * osc(t, 0.42) * energy,
    headYaw: 0.07 * osc(t, 3.1),
    rootY: 0.008 * Math.abs(osc(t, 0.84)) * energy,
  })
}

function happy(t: number): PoseOffsets {
  return offsets({
    bodyRoll: 0.06 * osc(t, 1.3),
    headRoll: 0.07 * osc(t, 1.3, Math.PI),
    rootX: 0.02 * osc(t, 1.3),
    armRaiseL: 0.12 * osc(t, 0.65),
    armRaiseR: -0.12 * osc(t, 0.65),
  })
}

const CELEBRATE_LOOP = 3.4

/** Festejo: se agacha, salta estirado con los brazos arriba, aterriza aplastado y festeja. */
function celebrating(t: number): PoseOffsets {
  const s = t % CELEBRATE_LOOP
  const air = s > 0.38 && s < 1.08 ? (s - 0.38) / 0.7 : -1
  const up = track(
    [
      [0, 0],
      [0.38, -0.12],
      [0.6, 1],
      [1.3, 1],
      [3.2, 0.85],
      [3.4, 0],
    ],
    s
  )
  const cheer = s > 1.3 ? Math.sin(s * Math.PI * 2 * 2.5) : 0
  return offsets({
    rootY:
      (air >= 0 ? 0.36 * 4 * air * (1 - air) : 0) +
      0.04 * Math.abs(cheer) * (s > 1.4 ? 1 : 0),
    squash: track(
      [
        [0, 0],
        [0.36, -0.16],
        [0.46, 0.12],
        [0.75, 0.03],
        [1.02, 0.06],
        [1.12, -0.13],
        [1.3, 0.03],
        [1.5, 0],
      ],
      s
    ),
    armRaiseL: ARM.up.raise * up + 0.22 * cheer,
    armRaiseR: ARM.up.raise * up - 0.22 * cheer,
    armSwingL:
      -0.3 *
      track(
        [
          [0, 0],
          [0.36, 1],
          [0.5, 0],
        ],
        s
      ),
    armSwingR:
      -0.3 *
      track(
        [
          [0, 0],
          [0.36, 1],
          [0.5, 0],
        ],
        s
      ),
    headPitch:
      0.08 *
      track(
        [
          [0, 0],
          [0.36, 1],
          [0.5, -0.8],
          [1.2, 0],
        ],
        s
      ),
    bodyRoll: 0.05 * osc(s, 1.0) * (s > 1.3 ? 1 : 0),
    iridescence: 0.8 * bump(s - 0.55, 10, 0.7),
  })
}

/** Dormido: cabeza caída, respiración honda y un «ronquido» cada tanto (se infla, boca en o). */
function sleeping(t: number): PoseOffsets {
  const puff = bump(t, 5.5, 1.2)
  return offsets({
    headPitch: 0.22 - 0.05 * puff,
    headRoll: 0.1 + 0.03 * osc(t, 9),
    armRaiseL: -0.08,
    armRaiseR: -0.08,
    squash: 0.035 * puff,
    mouthRound: 0.85 * puff,
    mouthOpen: 0.22 * puff,
    blush: 0.12 * puff,
  })
}

/** Sincronizando: levita, ojos cerrados y concentrados, brazos que flotan. */
function syncing(t: number): PoseOffsets {
  return offsets({
    rootY: 0.13 + 0.03 * osc(t, 2.6),
    armRaiseL: 0.45 + 0.08 * osc(t, 2.6, 1),
    armRaiseR: 0.45 + 0.08 * osc(t, 2.6, 1),
    armSwingL: 0.2,
    armSwingR: 0.2,
    headPitch: -0.05,
    bodyRoll: 0.02 * osc(t, 5.2),
  })
}

type Performance = (t: number, ctx: PerformanceContext) => PoseOffsets

const PERFORMANCES: Record<CompanionMood, Performance | null> = {
  idle: null,
  listening,
  thinking,
  speaking,
  happy,
  celebrating,
  sleeping,
  syncing,
  dancing,
  working,
  shy,
  worried,
  confused,
  presenting,
}

/** Momento de cada bucle que se usa como pose fija con movimiento reducido. */
export const STATIC_TIME: Record<CompanionMood, number> = {
  idle: 0,
  listening: 0,
  thinking: 1.6,
  speaking: 0.25,
  happy: 0,
  celebrating: 2.05,
  sleeping: 3,
  syncing: 0,
  dancing: 0.5,
  working: 2.8,
  shy: 0,
  worried: 3,
  confused: 0.9,
  presenting: 2,
}

/** Señales de una actuación que disparan una acción (el giro de cada dos festejos). */
export interface PerformanceCue {
  mood: CompanionMood
  period: number
  at: number
  every: number
  phase: number
  action: 'spin'
}

export const PERFORMANCE_CUES: readonly PerformanceCue[] = [
  {
    mood: 'celebrating',
    period: CELEBRATE_LOOP,
    at: 0.4,
    every: 2,
    phase: 1,
    action: 'spin',
  },
]

/** Señales cruzadas entre t0 y t1 (tiempo dentro del ánimo). */
export function cuesBetween(
  mood: CompanionMood,
  t0: number,
  t1: number
): PerformanceCue[] {
  const hits: PerformanceCue[] = []
  for (const cue of PERFORMANCE_CUES) {
    if (cue.mood !== mood || t1 <= t0) continue
    const loop = Math.floor((t1 - cue.at) / cue.period)
    const fireAt = loop * cue.period + cue.at
    if (
      loop >= 0 &&
      fireAt > t0 &&
      fireAt <= t1 &&
      loop % cue.every === cue.phase
    )
      hits.push(cue)
  }
  return hits
}

export function performanceOffsets(
  mood: CompanionMood,
  t: number,
  ctx: PerformanceContext
): Readonly<PoseOffsets> {
  const perf = PERFORMANCES[mood]
  return perf ? perf(t, ctx) : ZERO_OFFSETS
}
