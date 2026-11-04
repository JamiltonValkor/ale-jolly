import { COMPANION_FIDGETS, type CompanionFidget } from './companion-moods'
import { randomBetween, type Rng } from './random'

/**
 * Cada 6–14 s, un gesto pequeño al azar (con semilla) del repertorio; nunca
 * el mismo dos veces seguidas. Bostezar es más raro.
 */

export interface FidgetState {
  nextAt: number
  last: CompanionFidget | null
}

const WEIGHTS: Record<CompanionFidget, number> = {
  lookAtHand: 1,
  tinyHop: 1,
  stretch: 0.8,
  lookAround: 1.2,
  scratch: 1,
  shiftFeet: 1,
  yawn: 0.4,
}

export function scheduleFidget(now: number, rng: Rng): number {
  return now + randomBetween(rng, 6, 14)
}

export function createFidgetState(now: number, rng: Rng): FidgetState {
  return { nextAt: scheduleFidget(now, rng), last: null }
}

export function pickFidget(
  rng: Rng,
  last: CompanionFidget | null,
  allowed: readonly CompanionFidget[] = COMPANION_FIDGETS
): CompanionFidget {
  const pool = allowed.filter(f => f !== last)
  const total = pool.reduce((sum, f) => sum + WEIGHTS[f], 0)
  let roll = rng() * total
  for (const f of pool) {
    roll -= WEIGHTS[f]
    if (roll <= 0) return f
  }
  return pool[pool.length - 1]
}

export function stepFidget(
  state: FidgetState,
  now: number,
  rng: Rng,
  enabled: boolean,
  allowed?: readonly CompanionFidget[]
): { state: FidgetState; fire: CompanionFidget | null } {
  if (!enabled) {
    // Ocupado: el próximo gesto espera al menos 6 s después de volver al reposo.
    return {
      state: state.nextAt < now + 6 ? { ...state, nextAt: now + 6 } : state,
      fire: null,
    }
  }
  if (now < state.nextAt) return { state, fire: null }
  const fire = pickFidget(rng, state.last, allowed)
  return { state: { nextAt: scheduleFidget(now, rng), last: fire }, fire }
}

/** Forzar un gesto ya (p. ej. 20 s ignorado en modo interactivo). */
export function forceFidget(
  state: FidgetState,
  now: number,
  rng: Rng,
  allowed?: readonly CompanionFidget[]
) {
  const fire = pickFidget(rng, state.last, allowed)
  return { state: { nextAt: scheduleFidget(now, rng), last: fire }, fire }
}
