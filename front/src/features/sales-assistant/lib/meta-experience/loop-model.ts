import type {
  FirstLoopTask,
  FirstLoopWork,
} from '../../types/first-loop.schemas'

/** Las 5 estaciones del ciclo, en el orden en que trabaja el equipo. */
export const LOOP_STATIONS = [
  'research',
  'strategy',
  'structure',
  'analysis',
  'optimization',
] as const

export type LoopStation = (typeof LOOP_STATIONS)[number]
export type LoopStationStatus =
  | 'done'
  | 'running'
  | 'queued'
  | 'blocked'
  | 'idle'

export interface LoopStationItem {
  id: LoopStation
  status: LoopStationStatus
}

export interface LoopModel {
  stations: LoopStationItem[]
  /** Estación que está trabajando (o esperando algo del dueño), si hay. */
  current: LoopStation | null
  /** Vuelta del ciclo: la revisión del trabajo (sube con cada mejora). */
  round: number
  latest: { title: string; station: LoopStation } | null
  /** Hay trabajo en curso o hecho: el ciclo ya arrancó. */
  active: boolean
}

/** La síntesis cierra la vuelta: la mostramos como parte de «Mejora». */
function stationOf(stage: FirstLoopTask['stage']): LoopStation {
  return stage === 'summary' ? 'optimization' : stage
}

const RUNNING = new Set<FirstLoopTask['status']>(['running', 'awaiting_review'])
const BLOCKED = new Set<FirstLoopTask['status']>(['blocked', 'failed'])

function statusOf(tasks: FirstLoopTask[]): LoopStationStatus {
  const live = tasks.filter(task => task.status !== 'cancelled')
  if (live.some(task => BLOCKED.has(task.status))) return 'blocked'
  if (live.some(task => RUNNING.has(task.status))) return 'running'
  if (live.some(task => task.status === 'queued')) return 'queued'
  if (live.length > 0 && live.every(task => task.status === 'completed'))
    return 'done'
  return 'idle'
}

function currentOf(stations: LoopStationItem[]): LoopStation | null {
  const working = stations.find(
    station => station.status === 'running' || station.status === 'blocked'
  )
  if (working) return working.id
  return stations.find(station => station.status === 'queued')?.id ?? null
}

/**
 * Traduce el trabajo del equipo (tareas por perfil y etapa) a las estaciones
 * del ciclo en lenguaje humano. Sin trabajo, el ciclo está en espera.
 */
export function buildLoopModel(
  work: FirstLoopWork | null | undefined
): LoopModel {
  const tasks = work?.tasks ?? []
  const stations = LOOP_STATIONS.map(id => ({
    id,
    status: statusOf(tasks.filter(task => stationOf(task.stage) === id)),
  }))
  const last = work?.artifacts.at(-1)
  return {
    stations,
    current: currentOf(stations),
    round: work?.revision ?? 1,
    latest: last ? { title: last.title, station: stationOf(last.stage) } : null,
    active: tasks.length > 0,
  }
}
