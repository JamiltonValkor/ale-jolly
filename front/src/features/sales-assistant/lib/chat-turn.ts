import type { SalesAssistantStreamEvent } from '../types'

/**
 * Estado del turno del chat (OCF-005) a partir de los eventos v1 del stream.
 * Puro: el hook lo conecta al SDK; los componentes solo leen el resultado.
 */

/**
 * Fallo visible del turno: problema de su IA (`auth|quota|rate_limit`), el
 * asistente aún no está listo (`not_ready`, 409 del chat), se está
 * reiniciando (`restarting`: evento `assistant_restarting` o 503
 * `ASSISTANT_RESTARTING`, OCB-016) o genérico.
 */
export type ChatFailure =
  | 'generic'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'not_ready'
  | 'restarting'

export interface ChatExchange {
  userText: string
  reply: string
}

export interface ChatTurnState {
  phase: 'idle' | 'streaming' | 'failed'
  /** Turno en curso o el último que falló (para «Enviar de nuevo»). */
  current: ChatExchange | null
  /** Turnos completos que el historial del servicio todavía no devolvió. */
  unsynced: ChatExchange[]
  /** Nombres de las tools en uso; nunca se muestran. */
  activeTools: string[]
  /** El MCP de SaleADS no respondió: aviso de reconexión. */
  mcpPaused: boolean
  mcpFailedThisTurn: boolean
  failure: ChatFailure | null
}

export type ChatTurnAction =
  | { type: 'send'; text: string }
  | { type: 'event'; event: SalesAssistantStreamEvent }
  | {
      type: 'transport_failed'
      failure?: 'generic' | 'not_ready' | 'restarting'
    }
  | { type: 'synced'; history: ReadonlyArray<{ role: string; text: string }> }

export const INITIAL_CHAT_TURN: ChatTurnState = {
  phase: 'idle',
  current: null,
  unsynced: [],
  activeTools: [],
  mcpPaused: false,
  mcpFailedThisTurn: false,
  failure: null,
}

const SALEADS_TOOL_PREFIX = 'mcp__saleads__'

/** Tools del MCP de SaleADS (las únicas que pueden pausar el chat). */
export function isSaleadsTool(name: string): boolean {
  return name.startsWith(SALEADS_TOOL_PREFIX)
}

/** Tools que cambian el negocio activo del dueño (la web debe seguirlo). */
export function isBusinessSwitchTool(name: string): boolean {
  return (
    isSaleadsTool(name) &&
    (name.endsWith('select_business') || name.endsWith('create_business'))
  )
}

function fail(state: ChatTurnState, failure: ChatFailure): ChatTurnState {
  return { ...state, phase: 'failed', activeTools: [], failure }
}

function withoutTool(tools: string[], name: string): string[] {
  const index = tools.indexOf(name)
  return index === -1 ? tools : tools.filter((_, i) => i !== index)
}

function complete(state: ChatTurnState, current: ChatExchange): ChatTurnState {
  return {
    ...state,
    phase: 'idle',
    current: null,
    unsynced: [...state.unsynced, current],
    activeTools: [],
    mcpPaused: state.mcpFailedThisTurn,
  }
}

/**
 * El historial del servicio ya trae el último turno local si su último
 * mensaje del dueño es ese texto. Así un historial atrasado no borra el turno.
 */
function historyHasLatest(
  state: ChatTurnState,
  history: ReadonlyArray<{ role: string; text: string }>
): boolean {
  const latest = state.unsynced.at(-1)
  if (!latest) return false
  const lastUser = history.findLast(message => message.role === 'user')
  return lastUser?.text.trim() === latest.userText.trim()
}

function applyEvent(
  state: ChatTurnState,
  event: SalesAssistantStreamEvent
): ChatTurnState {
  const current = state.current
  if (state.phase !== 'streaming' || !current) return state
  switch (event.type) {
    case 'token':
      return {
        ...state,
        current: { ...current, reply: current.reply + event.text },
      }
    case 'tool_start':
      return { ...state, activeTools: [...state.activeTools, event.name] }
    case 'tool_end':
      return {
        ...state,
        activeTools: withoutTool(state.activeTools, event.name),
      }
    case 'mcp_unavailable':
      return { ...state, mcpPaused: true, mcpFailedThisTurn: true }
    case 'message_end':
      return complete(state, current)
    case 'provider_error':
      return fail(state, event.reason)
    case 'assistant_restarting':
      return fail(state, 'restarting')
    default:
      return fail(state, 'generic')
  }
}

export function chatTurnReducer(
  state: ChatTurnState,
  action: ChatTurnAction
): ChatTurnState {
  switch (action.type) {
    case 'send':
      return {
        ...state,
        phase: 'streaming',
        current: { userText: action.text, reply: '' },
        activeTools: [],
        mcpFailedThisTurn: false,
        failure: null,
      }
    case 'event':
      return applyEvent(state, action.event)
    case 'transport_failed':
      return state.phase === 'streaming'
        ? fail(state, action.failure ?? 'generic')
        : state
    case 'synced':
      return historyHasLatest(state, action.history)
        ? { ...state, unsynced: [] }
        : state
  }
}

/** Qué indicar mientras hay tools activas: datos de SaleADS u otra tarea. */
export function chatToolActivity(
  state: ChatTurnState
): 'saleads' | 'other' | null {
  if (state.activeTools.length === 0) return null
  return state.activeTools.some(isSaleadsTool) ? 'saleads' : 'other'
}
