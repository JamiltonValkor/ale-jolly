/** Estados de la cara 2D del compañero (pantalla del robot, tarjetas, avatar). */
export const FACE_STATES = [
  'sleeping',
  'waking',
  'idle',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'syncing',
  'error',
] as const

export type FaceState = (typeof FACE_STATES)[number]

export function isFaceState(value: unknown): value is FaceState {
  return (
    typeof value === 'string' &&
    (FACE_STATES as readonly string[]).includes(value)
  )
}
