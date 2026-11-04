import { SYNC_STEPS, type SyncStep } from '../types/pairing.schemas'

export type SyncStepState = 'done' | 'active' | 'pending'

/** Estado de cada uno de los tres pasos humanos según el paso real del back. */
export function syncStepStates(
  current: SyncStep | null,
  done: boolean
): Record<SyncStep, SyncStepState> {
  const index = current ? SYNC_STEPS.indexOf(current) : 0
  const entries = SYNC_STEPS.map((step, i) => {
    if (done || i < index) return [step, 'done'] as const
    return [step, i === index ? 'active' : 'pending'] as const
  })
  return Object.fromEntries(entries) as Record<SyncStep, SyncStepState>
}

/**
 * Progreso honesto: cada paso vale un tercio y solo se completa cuando el back
 * dice que terminó; el paso en curso llena la mitad de su tercio.
 */
export function syncProgress(current: SyncStep | null, done: boolean): number {
  if (done) return 1
  const index = current ? SYNC_STEPS.indexOf(current) : 0
  return (index + (current ? 0.5 : 0.22)) / SYNC_STEPS.length
}
