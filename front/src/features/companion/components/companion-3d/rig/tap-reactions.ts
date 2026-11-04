import { ACTION_DURATION } from './companion-actions'
import type { CompanionAction } from './companion-moods'
import type { Rng } from './random'

/**
 * Reacciones al tocarlo: cada toque sortea un movimiento distinto del
 * repertorio, nunca el de la vez anterior ni uno que ya esté en curso
 * (reiniciarlo lo cortaría en seco). Con movimiento reducido, solo gestos
 * suaves y pequeños, sin saltos ni giros.
 */

export const TAP_REACTIONS = [
  'jump',
  'giggle',
  'spin',
  'tinyHop',
  'wave',
  'surprised',
  'nod',
] as const satisfies readonly CompanionAction[]

export const CALM_TAP_REACTIONS = [
  'nod',
  'wave',
] as const satisfies readonly CompanionAction[]

/** Parte de la reacción que se deja terminar antes de aceptar otro toque (el final es la recuperación). */
const LOCK = 0.8

export interface TapContext {
  rng: Rng
  reducedMotion: boolean
  /** Acciones en curso o agendadas: no se reinician a mitad de camino. */
  active: readonly CompanionAction[]
}

/** `null` = no hay ninguna libre (con movimiento reducido): mejor no cortar la que está en curso. */
export function pickTapReaction(
  previous: CompanionAction | null,
  ctx: TapContext
): CompanionAction | null {
  const pool: readonly CompanionAction[] = ctx.reducedMotion
    ? CALM_TAP_REACTIONS
    : TAP_REACTIONS
  const options = pool.filter(a => a !== previous && !ctx.active.includes(a))
  if (options.length === 0) return null
  return options[
    Math.min(Math.floor(ctx.rng() * options.length), options.length - 1)
  ]
}

/** Cuánto espera esta reacción antes de aceptar otro toque. */
export function tapLockFor(action: CompanionAction): number {
  return ACTION_DURATION[action] * LOCK
}
