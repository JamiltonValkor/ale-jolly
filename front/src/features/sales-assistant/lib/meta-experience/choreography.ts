import type { CompanionMood } from '../../components/meta-experience/types'
import type { SalesAssistantStep } from '../../types'
import type { LoopModel } from './loop-model'
import type { PreparingAlert } from './preparing-alert'

/**
 * Coreografía del compañero: qué ánimo tiene en cada momento del producto.
 * Funciones puras (las pantallas solo las llaman), para que el personaje
 * cuente lo mismo que dice el texto.
 */

/** Llegada: duerme; si la persona se acerca al botón, despierta a mirar. */
export function startMood(input: {
  busy: boolean
  nearCta: boolean
}): CompanionMood {
  if (input.busy) return 'waking'
  return input.nearCta ? 'waking' : 'sleeping'
}

const STEP_MOOD: Record<SalesAssistantStep, CompanionMood> = {
  preparing_access: 'waking',
  preparing_environment: 'listening',
  installing_agent: 'working',
  configure_ai: 'syncing',
}

/** Preparación: despierta, escucha, trabaja y se sincroniza; se confunde o preocupa si algo falla. */
export function preparingMood(input: {
  step: SalesAssistantStep | null
  failed: boolean
  alert: PreparingAlert
}): CompanionMood {
  if (input.failed) return 'worried'
  if (input.alert === 'stuck') return 'confused'
  return STEP_MOOD[input.step ?? 'preparing_access']
}

/** «Hoy»: trabaja mientras el ciclo corre; se confunde si espera algo del dueño. */
export function todayMood(loop: LoopModel): CompanionMood {
  const current = loop.stations.find(station => station.id === loop.current)
  if (current?.status === 'blocked') return 'confused'
  if (current?.status === 'running') return 'working'
  return 'idle'
}

/** Cuánto «habla» una respuesta: proporcional al texto, entre 2,5 y 9 s. */
export function speakingMs(text: string): number {
  return Math.min(9_000, Math.max(2_500, text.length * 45))
}

/** Chat: piensa mientras responde, habla al llegar la respuesta, se preocupa si falla. */
export function chatMood(input: {
  busy: boolean
  turnFailed: boolean
  speaking: boolean
  typing: boolean
}): CompanionMood {
  if (input.turnFailed) return 'worried'
  if (input.busy) return 'thinking'
  if (input.speaking) return 'speaking'
  return input.typing ? 'listening' : 'idle'
}
