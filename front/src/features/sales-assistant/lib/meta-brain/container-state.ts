import type { BrainSnapshots } from '../../types'

/**
 * Del estado de React Query al estado de la vista de «Mi cerebro», en
 * funciones puras (el contenedor solo las llama).
 */
type Items = BrainSnapshots['items']

const WEEK = 7 * 86_400_000

/** «Qué cambió» compara por defecto la foto más nueva con la de hace una semana (o la anterior). */
export function defaultChangesRange(items: Items): {
  from: number | null
  to: number | null
} {
  if (items.length < 2) return { from: null, to: null }
  const latest = items[0]
  const target = Date.parse(latest.created_at) - WEEK
  const older = items.slice(1)
  const closest = older.reduce((best, item) =>
    Math.abs(Date.parse(item.created_at) - target) <
    Math.abs(Date.parse(best.created_at) - target)
      ? item
      : best
  )
  return { from: closest.version, to: latest.version }
}

export interface BrainStatusInput {
  snapshotsPending?: boolean
  snapshotsNotFound?: boolean
  snapshotsError?: boolean
  noItems?: boolean
  snapshotPending?: boolean
  snapshotError?: boolean
  nodes?: number
}

export function brainStatus(
  input: BrainStatusInput
): 'loading' | 'empty' | 'error' | 'ready' {
  if (input.snapshotsPending) return 'loading'
  if (input.snapshotsNotFound) return 'empty'
  if (input.snapshotsError) return 'error'
  if (input.noItems) return 'empty'
  if (input.snapshotPending) return 'loading'
  if (input.snapshotError) return 'error'
  return input.nodes ? 'ready' : 'empty'
}

export function changesStatus(input: {
  enabled: boolean
  pending?: boolean
  notFound?: boolean
  error?: boolean
  ready?: boolean
}): 'idle' | 'loading' | 'notYet' | 'error' | 'ready' {
  if (!input.enabled) return 'idle'
  if (input.notFound) return 'notYet'
  if (input.error) return 'error'
  if (input.ready) return 'ready'
  return input.pending ? 'loading' : 'idle'
}

export function feedbackStatus(input: {
  pending?: boolean
  success?: boolean
  delivered?: 'pending' | 'delivered'
  error?: boolean
  notFound?: boolean
  stopped?: boolean
}): 'idle' | 'pending' | 'sent' | 'queued' | 'error' | 'unavailable' {
  if (input.pending) return 'pending'
  if (input.success)
    return input.stopped || input.delivered === 'pending' ? 'queued' : 'sent'
  if (input.error) return input.notFound ? 'unavailable' : 'error'
  return 'idle'
}
