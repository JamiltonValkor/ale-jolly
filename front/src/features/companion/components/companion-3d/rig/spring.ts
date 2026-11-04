/**
 * Resorte amortiguado de un canal escalar. Es la única forma en que el rig
 * mueve un valor hacia su objetivo: así ningún cambio de ánimo «salta».
 * Integración semi-implícita con sub-pasos fijos para que sea estable aunque
 * el frame llegue tarde (pestaña que vuelve de segundo plano).
 */

export interface Spring {
  value: number
  velocity: number
}

export interface SpringConfig {
  /** Rigidez (1/s²). Más alto = llega antes. */
  stiffness: number
  /** Razón de amortiguamiento: 1 = crítico, < 1 rebota un poco. */
  damping: number
}

const SUBSTEP = 1 / 120
const MAX_DT = 0.25

export function createSpring(value: number): Spring {
  return { value, velocity: 0 }
}

export function stepSpring(
  spring: Spring,
  target: number,
  dt: number,
  { stiffness, damping }: SpringConfig
): Spring {
  let { value, velocity } = spring
  let remaining = Math.min(Math.max(dt, 0), MAX_DT)
  const c = 2 * damping * Math.sqrt(stiffness)
  while (remaining > 1e-6) {
    const h = Math.min(SUBSTEP, remaining)
    const accel = stiffness * (target - value) - c * velocity
    velocity += accel * h
    value += velocity * h
    remaining -= h
  }
  return { value, velocity }
}

export function isSpringSettled(
  spring: Spring,
  target: number,
  epsilon = 0.002
): boolean {
  return (
    Math.abs(spring.value - target) < epsilon &&
    Math.abs(spring.velocity) < epsilon * 10
  )
}
