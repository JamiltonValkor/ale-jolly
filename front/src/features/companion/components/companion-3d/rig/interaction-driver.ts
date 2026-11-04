import { isCalmAction } from './companion-actions'
import type { CompanionAction } from './companion-moods'
import { triggerAction, triggerFidget, type RigState } from './companion-rig'
import {
  createInteraction,
  interact,
  tickInteraction,
  type InteractionEvent,
  type InteractionState,
} from './interaction'
import type { Rng } from './random'

/**
 * Pegamento entre la máquina de interacción y el rig: guarda las acciones
 * agendadas (p. ej. el saludo 1 s después de la sorpresa) y las suelta a
 * tiempo, en el reloj del rig.
 */

export interface DriverState {
  interaction: InteractionState
  pending: { action: CompanionAction; at: number }[]
}

export function createDriver(now: number): DriverState {
  return { interaction: createInteraction(now), pending: [] }
}

/** Un toque tampoco elige lo que ya está agendado (p. ej. el saludo que sigue a la sorpresa). */
function withPending(
  event: InteractionEvent,
  d: DriverState
): InteractionEvent {
  if (event.type !== 'click' || d.pending.length === 0) return event
  return {
    ...event,
    tap: {
      ...event.tap,
      active: [...event.tap.active, ...d.pending.map(p => p.action)],
    },
  }
}

export function driverEvent(
  d: DriverState,
  event: InteractionEvent,
  now: number
): DriverState {
  const out = interact(d.interaction, withPending(event, d), now)
  return {
    interaction: out.state,
    pending: [
      ...d.pending,
      ...out.actions.map(a => ({ action: a.action, at: now + a.delay })),
    ],
  }
}

export function driverTick(
  d: DriverState,
  now: number
): { state: DriverState; fire: CompanionAction[]; fidget: boolean } {
  const out = tickInteraction(d.interaction, now)
  const pending = [
    ...d.pending,
    ...out.actions.map(a => ({ action: a.action, at: now + a.delay })),
  ]
  const fire = pending.filter(p => p.at <= now).map(p => p.action)
  return {
    state: { interaction: out.state, pending: pending.filter(p => p.at > now) },
    fire,
    fidget: out.fidget,
  }
}

/**
 * Suelta sobre el rig lo que toca ahora (toques, roces, la sorpresa al
 * acercarse, el fidget por ignorarlo). Quien avanza el rig tiene que avanzar
 * ESTE rig: si avanza el de antes, las reacciones se pierden sin ruido.
 */
export function releaseDue(
  d: DriverState,
  rig: RigState,
  opts: { reducedMotion: boolean; rng: Rng }
): { driver: DriverState; rig: RigState } {
  const out = driverTick(d, rig.time)
  let next = rig
  for (const action of out.fire) {
    if (!opts.reducedMotion || isCalmAction(action))
      next = triggerAction(next, action)
  }
  if (out.fidget && !opts.reducedMotion) next = triggerFidget(next, opts.rng)
  return { driver: out.state, rig: next }
}
