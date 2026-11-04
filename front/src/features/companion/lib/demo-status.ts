import type { PairingStatus, SyncStep } from '../types/pairing.schemas'
import type { DemoPairingRecord } from './demo-store'

/** Línea de tiempo de la sincronización simulada del modo demo. */

/** Fin (ms desde el reclamo) de cada tramo de la sincronización simulada. */
export const DEMO_SYNC_PLAN_MS = {
  claimed: 900,
  knowledge: 3400,
  voice: 5400,
  ready: 7200,
} as const

export function syncStepAt(elapsed: number): SyncStep {
  if (elapsed < DEMO_SYNC_PLAN_MS.knowledge) return 'knowledge'
  if (elapsed < DEMO_SYNC_PLAN_MS.voice) return 'voice'
  return 'ready'
}

function names(record: DemoPairingRecord) {
  return {
    ...(record.owner_first_name
      ? { owner_first_name: record.owner_first_name }
      : {}),
    ...(record.business_name ? { business_name: record.business_name } : {}),
  }
}

export function deriveDemoStatus(
  record: DemoPairingRecord,
  now: number
): PairingStatus {
  if (record.claimed_at === null) {
    return { status: now > record.expires_at ? 'expired' : 'waiting' }
  }
  const elapsed = now - record.claimed_at
  if (elapsed < DEMO_SYNC_PLAN_MS.claimed) {
    return { status: 'claimed', ...names(record) }
  }
  if (elapsed >= DEMO_SYNC_PLAN_MS.ready) {
    return { status: 'paired', ...names(record) }
  }
  return { status: 'syncing', sync_step: syncStepAt(elapsed), ...names(record) }
}

export function isPairedRecord(
  record: DemoPairingRecord | null,
  now: number
): boolean {
  if (!record || record.claimed_at === null) return false
  return now - record.claimed_at >= DEMO_SYNC_PLAN_MS.ready
}
