import type { MoodPreset } from './companion-moods'
import {
  createSpring,
  isSpringSettled,
  stepSpring,
  type Spring,
  type SpringConfig,
} from './spring'

/**
 * Canales con resorte de la pose base: cada ánimo fija objetivos y estos
 * canales los persiguen. Así ningún cambio de ánimo salta.
 */

const CHANNELS = {
  eyeOpen: { stiffness: 150, damping: 0.95 },
  eyeScale: { stiffness: 120, damping: 0.62 },
  lidCurve: { stiffness: 120, damping: 0.95 },
  focus: { stiffness: 90, damping: 0.95 },
  smile: { stiffness: 90, damping: 0.9 },
  mouthOpen: { stiffness: 420, damping: 0.78 },
  mouthRound: { stiffness: 380, damping: 0.85 },
  mouthWidth: { stiffness: 90, damping: 0.9 },
  blush: { stiffness: 30, damping: 1 },
  gazeX: { stiffness: 190, damping: 0.86 },
  gazeY: { stiffness: 190, damping: 0.86 },
  headYaw: { stiffness: 26, damping: 0.86 },
  headPitch: { stiffness: 26, damping: 0.86 },
  lean: { stiffness: 22, damping: 0.9 },
  tilt: { stiffness: 22, damping: 0.9 },
  breathRate: { stiffness: 10, damping: 1 },
  breathAmp: { stiffness: 10, damping: 1 },
  swayAmp: { stiffness: 10, damping: 1 },
  swayRate: { stiffness: 10, damping: 1 },
  hopAmp: { stiffness: 18, damping: 1 },
  hopRate: { stiffness: 18, damping: 1 },
  armLift: { stiffness: 40, damping: 0.8 },
  armFlap: { stiffness: 20, damping: 1 },
  iridescence: { stiffness: 9, damping: 1 },
  syncWave: { stiffness: 9, damping: 1 },
  life: { stiffness: 8, damping: 1 },
} satisfies Record<string, SpringConfig>

export type ChannelKey = keyof typeof CHANNELS
export type Targets = Record<ChannelKey, number>
export type Channels = Record<ChannelKey, Spring>
export const CHANNEL_KEYS = Object.keys(CHANNELS) as ChannelKey[]

export function presetTargets(p: MoodPreset, reducedMotion: boolean): Targets {
  const still = reducedMotion ? 0 : 1
  return {
    eyeOpen: p.eyeOpen,
    eyeScale: p.eyeScale,
    lidCurve: p.lidCurve,
    focus: p.focus,
    smile: p.smile,
    mouthOpen: p.mouthOpen,
    mouthRound: 0,
    mouthWidth: p.mouthWidth,
    blush: p.blush,
    gazeX: p.gazeX,
    gazeY: p.gazeY,
    headYaw: p.gazeX * 0.22,
    headPitch: -p.gazeY * 0.14,
    lean: p.lean,
    tilt: p.tilt,
    breathRate: p.breathRate,
    breathAmp: p.breathAmp * still,
    swayAmp: p.swayAmp * still,
    swayRate: p.swayRate,
    hopAmp: p.hopAmp * still,
    hopRate: p.hopRate,
    armLift: p.armLift,
    armFlap: p.armFlap * still,
    iridescence: p.iridescence,
    syncWave: p.syncWave,
    life: p.life * still,
  }
}

export function createChannels(targets: Targets): Channels {
  const channels = {} as Channels
  for (const k of CHANNEL_KEYS) channels[k] = createSpring(targets[k])
  return channels
}

export function stepChannels(
  channels: Channels,
  targets: Targets,
  dt: number
): { channels: Channels; settled: boolean } {
  const next = {} as Channels
  let settled = true
  for (const k of CHANNEL_KEYS) {
    next[k] = stepSpring(channels[k], targets[k], dt, CHANNELS[k])
    if (!isSpringSettled(next[k], targets[k])) settled = false
  }
  return { channels: next, settled }
}

export function channelValues(channels: Channels): Targets {
  const v = {} as Targets
  for (const k of CHANNEL_KEYS) v[k] = channels[k].value
  return v
}
