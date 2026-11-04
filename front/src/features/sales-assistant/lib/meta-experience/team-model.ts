import type {
  FirstLoopTask,
  FirstLoopWork,
} from '../../types/first-loop.schemas'
import type { StockSummary } from '../../types/stock.schemas'

/** El equipo que la dueña ve en la oficina. El curador es interno y no está. */
export const TEAM_ROLES = [
  'ale',
  'investigador',
  'estratega',
  'estructurador',
  'analista',
  'optimizador',
  'landings',
  'bodega',
] as const

export type TeamRole = (typeof TEAM_ROLES)[number]
export type TeamState = 'working' | 'waiting' | 'blocked' | 'done' | 'resting'
export type TeamNote = 'queued' | 'soon' | 'orders' | 'coordinating' | null

export interface TeamMember {
  role: TeamRole
  state: TeamState
  /** Lo que tiene entre manos: texto del servidor, se muestra como dato. */
  task: { title: string; since: string | null } | null
  lastDone: string | null
  note: TeamNote
  count: number | null
}

export interface TeamModel {
  members: TeamMember[]
  freshness: { status: 'fresh' | 'stale' | 'error'; observedAt: string | null }
  summary: Record<'working' | 'waiting' | 'blocked' | 'resting', number>
  /** Hay trabajo del ciclo: si no, el equipo espera el objetivo. */
  active: boolean
}

export interface TeamModelOptions {
  stockEnabled: boolean
  error?: boolean
}

type CycleRole = FirstLoopTask['profile']

const RUNNING = new Set<FirstLoopTask['status']>(['running', 'awaiting_review'])
const BLOCKED = new Set<FirstLoopTask['status']>(['blocked', 'failed'])

const member = (
  role: TeamRole,
  state: TeamState,
  extra: Partial<Omit<TeamMember, 'role' | 'state'>> = {}
): TeamMember => ({
  role,
  state,
  task: null,
  lastDone: null,
  note: null,
  count: null,
  ...extra,
})

const newest = (tasks: FirstLoopTask[]) =>
  [...tasks].sort((a, b) =>
    (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
  )[0]

/** Mismas reglas que el ciclo (`loop-model`), ahora por perfil. */
function cycleMember(role: CycleRole, all: FirstLoopTask[]): TeamMember {
  const tasks = all.filter(
    task => task.profile === role && task.status !== 'cancelled'
  )
  const done = newest(tasks.filter(task => task.status === 'completed'))
  const lastDone = done?.title ?? null
  const blocked = tasks.find(task => BLOCKED.has(task.status))
  const running = tasks.find(task => RUNNING.has(task.status))
  const current = blocked ?? running
  const task = current
    ? { title: current.title, since: current.updated_at }
    : null
  if (blocked) return member(role, 'blocked', { task, lastDone })
  if (running) return member(role, 'working', { task, lastDone })
  if (tasks.some(item => item.status === 'queued'))
    return member(role, 'resting', { lastDone, note: 'queued' })
  if (tasks.length > 0 && tasks.every(item => item.status === 'completed'))
    return member(role, 'done', { lastDone })
  return member(role, 'resting', { lastDone })
}

function aleMember(work: FirstLoopWork | null | undefined): TeamMember {
  if (work?.status === 'awaiting_feedback') return member('ale', 'waiting')
  if (work?.status === 'running' || work?.status === 'reviewing')
    return member('ale', 'working', { note: 'coordinating' })
  return member('ale', 'resting')
}

function bodegaMember(stock: StockSummary | undefined): TeamMember {
  if (stock && stock.propuestas_pendientes > 0)
    return member('bodega', 'waiting', { count: stock.propuestas_pendientes })
  if (stock && stock.pedidos_en_curso > 0)
    return member('bodega', 'working', {
      note: 'orders',
      count: stock.pedidos_en_curso,
    })
  return member('bodega', 'resting')
}

function freshnessOf(
  work: FirstLoopWork | null | undefined,
  error: boolean
): TeamModel['freshness'] {
  if (error) return { status: 'error', observedAt: null }
  const projection = work?.projection
  const observedAt = projection?.observed_at ?? null
  if (projection?.status === 'fresh' && observedAt)
    return { status: 'fresh', observedAt }
  return { status: 'stale', observedAt }
}

/** Sin dato fresco nadie aparece trabajando: nunca se simula actividad. */
function settle(item: TeamMember, fresh: boolean): TeamMember {
  if (fresh || item.state !== 'working' || item.role === 'bodega') return item
  return { ...item, state: 'resting', task: null, note: null }
}

function summarize(members: TeamMember[]): TeamModel['summary'] {
  const summary = { working: 0, waiting: 0, blocked: 0, resting: 0 }
  for (const item of members) {
    const key = item.state === 'done' ? 'resting' : item.state
    summary[key] += 1
  }
  return summary
}

/**
 * Traduce el trabajo del primer ciclo y el resumen de Stock al estado de cada
 * agente de la oficina. Lo que no tiene dato descansa.
 */
export function buildTeamModel(
  work: FirstLoopWork | null | undefined,
  stock: StockSummary | undefined,
  { stockEnabled, error = false }: TeamModelOptions
): TeamModel {
  const freshness = freshnessOf(work, error)
  const tasks = error ? [] : (work?.tasks ?? [])
  const cycle: CycleRole[] = [
    'investigador',
    'estratega',
    'estructurador',
    'analista',
    'optimizador',
  ]
  const members = [
    error ? member('ale', 'resting') : aleMember(work),
    ...cycle.map(role => cycleMember(role, tasks)),
    member('landings', 'resting', { note: 'soon' }),
    ...(stockEnabled ? [bodegaMember(stock)] : []),
  ].map(item => settle(item, freshness.status === 'fresh'))
  return {
    members,
    freshness,
    summary: summarize(members),
    active: tasks.length > 0,
  }
}
