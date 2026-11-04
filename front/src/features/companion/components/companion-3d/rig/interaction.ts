import type { CompanionAction } from './companion-moods'
import { pickTapReaction, tapLockFor, type TapContext } from './tap-reactions'

/**
 * Interactividad (`interactive`): al acercarte o rozarlo te saluda suave
 * (ladea la cabeza y sonríe, una vez cada tanto), reacciona distinto cada vez
 * que lo tocas, hace un gesto si lo ignoras 20 s y se duerme a los ~60 s;
 * despierta al mover el puntero. Máquina de estados pura.
 */

export const INTERACTION = {
  /** Distancia del puntero en radios del lienzo. */
  near: 1.15,
  far: 1.8,
  /** Entre un saludo suave y el siguiente (acercarse y rozarlo cuentan igual). */
  helloCooldown: 6,
  ignoredFidget: 20,
  dozeAfter: 60,
} as const

export interface InteractionState {
  lastActivityAt: number
  hovering: boolean
  lastHelloAt: number
  far: boolean
  drowsy: boolean
  ignoredFidgetDone: boolean
  /** Última reacción al toque (la siguiente es otra) y hasta cuándo se deja terminar. */
  lastTap: CompanionAction | null
  tapLockUntil: number
}

export type InteractionEvent =
  | { type: 'move'; distance: number }
  | { type: 'enter' }
  | { type: 'leave' }
  | { type: 'click'; tap: TapContext }

export interface ScheduledAction {
  action: CompanionAction
  delay: number
}

export interface InteractionOutput {
  state: InteractionState
  actions: ScheduledAction[]
  /** Pide un gesto de reposo (lleva 20 s ignorado). */
  fidget: boolean
}

export function createInteraction(now: number): InteractionState {
  return {
    lastActivityAt: now,
    hovering: false,
    lastHelloAt: -Infinity,
    far: true,
    drowsy: false,
    ignoredFidgetDone: false,
    lastTap: null,
    tapLockUntil: -Infinity,
  }
}

function active(state: InteractionState, now: number): InteractionState {
  return { ...state, lastActivityAt: now, ignoredFidgetDone: false }
}

function onMove(
  s: InteractionState,
  distance: number,
  now: number
): InteractionOutput {
  let state = active(s, now)
  if (state.drowsy) {
    return {
      state: { ...state, drowsy: false, far: distance > INTERACTION.far },
      actions: [{ action: 'wake', delay: 0 }],
      fidget: false,
    }
  }
  if (distance < INTERACTION.near && state.far)
    return hello({ ...state, far: false }, now)
  if (distance > INTERACTION.far && !state.far) state = { ...state, far: true }
  return { state, actions: [], fidget: false }
}

/** Saludo suave, sin repetirlo seguido (acercarse y luego rozarlo es un solo saludo). */
function hello(state: InteractionState, now: number): InteractionOutput {
  if (now - state.lastHelloAt <= INTERACTION.helloCooldown)
    return { state, actions: [], fidget: false }
  return {
    state: { ...state, lastHelloAt: now },
    actions: [{ action: 'hello', delay: 0 }],
    fidget: false,
  }
}

/** Toque: un movimiento distinto cada vez; si el anterior sigue en el aire, lo deja terminar. */
function onTap(
  state: InteractionState,
  tap: TapContext,
  now: number
): InteractionOutput {
  const action =
    now < state.tapLockUntil ? null : pickTapReaction(state.lastTap, tap)
  if (!action) return { state, actions: [], fidget: false }
  return {
    state: {
      ...state,
      lastTap: action,
      tapLockUntil: now + tapLockFor(action),
    },
    actions: [{ action, delay: 0 }],
    fidget: false,
  }
}

export function interact(
  s: InteractionState,
  event: InteractionEvent,
  now: number
): InteractionOutput {
  if (event.type === 'move') return onMove(s, event.distance, now)
  if (event.type === 'leave')
    return { state: { ...s, hovering: false }, actions: [], fidget: false }
  const state = active(s, now)
  if (state.drowsy) {
    return {
      state: { ...state, drowsy: false, hovering: event.type === 'enter' },
      actions: [{ action: 'wake', delay: 0 }],
      fidget: false,
    }
  }
  if (event.type === 'click') return onTap(state, event.tap, now)
  return hello({ ...state, hovering: true }, now)
}

export function tickInteraction(
  s: InteractionState,
  now: number
): InteractionOutput {
  const idle = now - s.lastActivityAt
  if (!s.drowsy && idle > INTERACTION.dozeAfter) {
    return { state: { ...s, drowsy: true }, actions: [], fidget: false }
  }
  if (!s.drowsy && !s.ignoredFidgetDone && idle > INTERACTION.ignoredFidget) {
    return {
      state: { ...s, ignoredFidgetDone: true },
      actions: [],
      fidget: true,
    }
  }
  return { state: s, actions: [], fidget: false }
}
