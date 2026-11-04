import type { CompanionAction, CompanionMood } from './companion-moods'

/**
 * Carrete de demostración (`autoplay`): recorre cada estado y cada acción,
 * 4–6 s cada uno, en un orden que cuenta una pequeña historia.
 */

export interface ReelStep {
  mood: CompanionMood
  action?: CompanionAction
  /** Segundos que dura el paso. */
  duration: number
}

export const DEMO_REEL: readonly ReelStep[] = [
  { mood: 'idle', duration: 6 },
  { mood: 'idle', action: 'wave', duration: 4 },
  { mood: 'listening', duration: 5 },
  { mood: 'listening', action: 'nod', duration: 4 },
  { mood: 'thinking', duration: 6 },
  { mood: 'speaking', duration: 6 },
  { mood: 'idle', action: 'shake', duration: 4 },
  { mood: 'working', duration: 6 },
  { mood: 'presenting', duration: 6 },
  { mood: 'idle', action: 'present', duration: 4 },
  { mood: 'syncing', duration: 6 },
  { mood: 'happy', duration: 5 },
  { mood: 'celebrating', duration: 7 },
  { mood: 'idle', action: 'jump', duration: 4 },
  { mood: 'idle', action: 'spin', duration: 4 },
  { mood: 'dancing', duration: 6 },
  { mood: 'idle', action: 'surprised', duration: 4 },
  { mood: 'idle', action: 'giggle', duration: 4 },
  { mood: 'idle', action: 'hello', duration: 4 },
  { mood: 'shy', duration: 6 },
  { mood: 'confused', duration: 6 },
  { mood: 'worried', duration: 6 },
  { mood: 'idle', action: 'sigh', duration: 4 },
  { mood: 'idle', action: 'lookAtHand', duration: 4 },
  { mood: 'idle', action: 'lookAround', duration: 4 },
  { mood: 'idle', action: 'scratch', duration: 4 },
  { mood: 'idle', action: 'shiftFeet', duration: 4 },
  { mood: 'idle', action: 'tinyHop', duration: 4 },
  { mood: 'idle', action: 'stretch', duration: 4 },
  { mood: 'idle', action: 'yawn', duration: 4 },
  { mood: 'sleeping', duration: 7 },
  { mood: 'idle', action: 'wake', duration: 5 },
]

export const DEMO_REEL_LENGTH = DEMO_REEL.reduce(
  (sum, s) => sum + s.duration,
  0
)

/** Paso del carrete en el segundo `elapsed` (da la vuelta al terminar). */
export function reelStepAt(elapsed: number): {
  index: number
  step: ReelStep
  startsAt: number
} {
  let t = ((elapsed % DEMO_REEL_LENGTH) + DEMO_REEL_LENGTH) % DEMO_REEL_LENGTH
  const loopStart = elapsed - t
  let startsAt = 0
  for (let i = 0; i < DEMO_REEL.length; i++) {
    if (t < DEMO_REEL[i].duration)
      return { index: i, step: DEMO_REEL[i], startsAt: loopStart + startsAt }
    t -= DEMO_REEL[i].duration
    startsAt += DEMO_REEL[i].duration
  }
  return {
    index: 0,
    step: DEMO_REEL[0],
    startsAt: loopStart + DEMO_REEL_LENGTH,
  }
}
