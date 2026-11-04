import { offsets, type PoseOffsets } from './pose-offsets'
import { randomBetween, type Rng } from './random'

/**
 * «Reposo vivo»: capas de micro movimiento con ruido suave y periodos
 * inconmensurables (nunca se sincronizan ni se repiten a la vista), más
 * sacadas oculares: miradas rápidas que vuelven a ti.
 */

/** Ruido suave en [−1, 1]: suma de senos con frecuencias irracionales y fases con semilla. */
export function smoothNoise(t: number, seed: number): number {
  const a = Math.sin(t * 1.0 + seed * 12.9898)
  const b = Math.sin(t * 1.618 + seed * 78.233) * 0.6
  const c = Math.sin(t * 2.718 + seed * 37.719) * 0.35
  return (a + b + c) / 1.95
}

/** Micro cambios de peso, deriva de la cabeza y brazos que se mecen. */
export function idleLife(t: number, seed: number, amount: number): PoseOffsets {
  if (amount <= 0) return offsets({})
  const n = (speed: number, k: number) =>
    smoothNoise(t * speed, seed + k) * amount
  return offsets({
    rootX: 0.022 * n(0.11, 1),
    bodyRoll: 0.024 * n(0.09, 2),
    bodyPitch: 0.012 * n(0.07, 3),
    headRoll: 0.055 * n(0.06, 4),
    headYaw: 0.05 * n(0.05, 5),
    headPitch: 0.025 * n(0.08, 6),
    armRaiseL: 0.045 * n(0.13, 7),
    armRaiseR: 0.045 * n(0.12, 8),
    armSwingL: 0.05 * n(0.1, 9),
    armSwingR: 0.05 * n(0.105, 10),
    squash: 0.006 * n(0.15, 11),
  })
}

/** La respiración no es un metrónomo: el ritmo varía ±12 %. */
export function breathJitter(t: number, seed: number): number {
  return 1 + 0.12 * smoothNoise(t * 0.05, seed + 20)
}

export interface Saccade {
  nextAt: number
  until: number
  x: number
  y: number
}

export function createSaccade(now: number, rng: Rng): Saccade {
  return { nextAt: now + randomBetween(rng, 0.9, 3.2), until: 0, x: 0, y: 0 }
}

export function stepSaccade(
  s: Saccade,
  now: number,
  rng: Rng,
  enabled: boolean
): Saccade {
  if (!enabled) return s.until > now ? { ...s, until: now } : s
  if (now < s.nextAt) return s
  const until = now + randomBetween(rng, 0.2, 0.7)
  return {
    nextAt: until + randomBetween(rng, 0.9, 3.2),
    until,
    x: randomBetween(rng, -0.22, 0.22),
    y: randomBetween(rng, -0.12, 0.12),
  }
}

/** Desplazamiento de la mirada por la sacada en curso (0 cuando ya volvió). */
export function saccadeGaze(s: Saccade, now: number): { x: number; y: number } {
  return now < s.until ? { x: s.x, y: s.y } : { x: 0, y: 0 }
}
