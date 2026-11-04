import { randomBetween, type Rng } from './random'

/**
 * Parpadeo: cada 2–6 s (muy raro con reduced motion), cierre rápido y
 * apertura más lenta, con un 18 % de parpadeos dobles para que se sienta vivo.
 */

export const BLINK_DURATION = 0.17
const DOUBLE_BLINK_CHANCE = 0.18
const DOUBLE_BLINK_GAP = 0.26

export interface BlinkState {
  /** Momento (s) en que empieza el próximo parpadeo. */
  nextAt: number
  /** Inicio del parpadeo en curso, o null. */
  startedAt: number | null
  /** Queda un segundo parpadeo pendiente (parpadeo doble). */
  pendingDouble: boolean
}

export interface BlinkOptions {
  enabled: boolean
  reducedMotion: boolean
}

export function scheduleNextBlink(
  now: number,
  rng: Rng,
  reducedMotion: boolean
): number {
  return reducedMotion
    ? now + randomBetween(rng, 12, 20)
    : now + randomBetween(rng, 2, 6)
}

export function createBlinkState(
  now: number,
  rng: Rng,
  reducedMotion: boolean
): BlinkState {
  return {
    nextAt: scheduleNextBlink(now, rng, reducedMotion),
    startedAt: null,
    pendingDouble: false,
  }
}

/** 0 = ojo abierto, 1 = cerrado. `t` = segundos desde que empezó el parpadeo. */
export function blinkClosure(t: number): number {
  if (t <= 0 || t >= BLINK_DURATION) return 0
  const closeEnd = BLINK_DURATION * 0.38
  if (t < closeEnd) {
    const x = t / closeEnd
    return x * x * (3 - 2 * x)
  }
  const x = (t - closeEnd) / (BLINK_DURATION - closeEnd)
  return 1 - x * x * (3 - 2 * x)
}

export function stepBlink(
  state: BlinkState,
  now: number,
  rng: Rng,
  { enabled, reducedMotion }: BlinkOptions
): { state: BlinkState; closure: number } {
  if (!enabled) {
    const idle = state.startedAt === null && now < state.nextAt
    return {
      state: idle
        ? state
        : {
            nextAt: scheduleNextBlink(now, rng, reducedMotion),
            startedAt: null,
            pendingDouble: false,
          },
      closure: 0,
    }
  }
  let next = state
  if (next.startedAt === null && now >= next.nextAt) {
    next = {
      ...next,
      startedAt: next.nextAt,
      pendingDouble: !reducedMotion && rng() < DOUBLE_BLINK_CHANCE,
    }
  }
  if (next.startedAt === null) return { state: next, closure: 0 }
  const elapsed = now - next.startedAt
  if (elapsed < BLINK_DURATION) {
    return { state: next, closure: blinkClosure(elapsed) }
  }
  const nextAt = next.pendingDouble
    ? now + DOUBLE_BLINK_GAP - BLINK_DURATION
    : scheduleNextBlink(now, rng, reducedMotion)
  return {
    state: { nextAt, startedAt: null, pendingDouble: false },
    closure: 0,
  }
}
