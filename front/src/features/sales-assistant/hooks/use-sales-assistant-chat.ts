'use client'

import { useAssistantRuntime } from '../runtime'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  chatTurnReducer,
  INITIAL_CHAT_TURN,
  isBusinessSwitchTool,
  type ChatTurnState,
} from '../lib/chat-turn'
import { SalesAssistantClientError } from '../sdk/sales-assistant-client'
import type { SalesAssistantMessage } from '../types'
import { useSalesAssistantBusinessSync } from './use-sales-assistant-business-sync'
import {
  useSalesAssistantMe,
  useSalesAssistantUserId,
} from './use-sales-assistant-me'
import { useCreateSalesAssistantSessionMutation } from './use-sales-assistant-mutations'
import { useSalesAssistantMessages } from './use-sales-assistant-queries'

export interface SalesAssistantChat {
  history: SalesAssistantMessage[]
  historyStatus: 'loading' | 'error' | 'ready'
  turn: ChatTurnState
  canSend: boolean
  send: (text: string) => Promise<void>
  retry: () => Promise<void>
}

/** Relee el historial tras `message_end` y se lo pasa al reducer para quitar los turnos locales. */
function useHistorySync(onSynced: (history: SalesAssistantMessage[]) => void) {
  const {
    keys: salesAssistantKeys,
    client: { fetchSalesAssistantMessages },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const userId = useSalesAssistantUserId() ?? 'anonymous'
  return useCallback(
    async (sessionId: string) => {
      try {
        const queryFn = ({ signal }: { signal: AbortSignal }) =>
          fetchSalesAssistantMessages(sessionId, signal)
        const data = await queryClient.fetchQuery({
          queryKey: salesAssistantKeys.messages(userId, sessionId),
          queryFn,
          staleTime: 0,
        })
        onSynced(data.messages)
      } catch {
        // El turno sigue visible desde el estado local hasta el próximo refresco.
      }
    },
    [
      queryClient,
      userId,
      onSynced,
      salesAssistantKeys,
      fetchSalesAssistantMessages,
    ]
  )
}

/** 409 del chat: el asistente dejó de estar listo (se prepara, se apagó…). */
function isNotReady(error: unknown): boolean {
  return (
    error instanceof SalesAssistantClientError &&
    error.code === 'ASSISTANT_NOT_READY'
  )
}

/** 503 del chat (OCB-016): Hermes se reinicia; el dueño reenvía en segundos. */
function isRestarting(error: unknown): boolean {
  return (
    error instanceof SalesAssistantClientError &&
    error.code === 'ASSISTANT_RESTARTING'
  )
}

/**
 * Chat con el asistente (OCF-005): historial de la sesión activa y turnos en
 * streaming con los eventos v1. Desmontar aborta el turno en curso.
 */
export function useSalesAssistantChat(): SalesAssistantChat {
  const { keys: salesAssistantKeys, streamTurn: streamSalesAssistantTurn } =
    useAssistantRuntime()
  const me = useSalesAssistantMe()
  const queryClient = useQueryClient()
  const userId = useSalesAssistantUserId() ?? 'anonymous'
  const sessionId = me.data?.session_id ?? null
  const messages = useSalesAssistantMessages(sessionId)
  const createSession = useCreateSalesAssistantSessionMutation()
  const syncBusiness = useSalesAssistantBusinessSync()
  const [turn, dispatch] = useReducer(chatTurnReducer, INITIAL_CHAT_TURN)
  const syncHistory = useHistorySync(
    useCallback(
      (history: SalesAssistantMessage[]) =>
        dispatch({ type: 'synced', history }),
      []
    )
  )
  const controller = useRef<AbortController | null>(null)
  const lastText = useRef<string | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const send = useCallback(
    async (text: string) => {
      if (controller.current) return
      const abort = new AbortController()
      controller.current = abort
      lastText.current = text
      dispatch({ type: 'send', text })
      try {
        const id = sessionId ?? (await createSession.mutateAsync()).session_id
        for await (const event of streamSalesAssistantTurn(
          id,
          text,
          abort.signal
        )) {
          dispatch({ type: 'event', event })
          if (
            event.type === 'tool_end' &&
            event.ok &&
            isBusinessSwitchTool(event.name)
          )
            void syncBusiness()
          if (event.type === 'message_end') void syncHistory(id)
        }
      } catch (error) {
        if (!abort.signal.aborted && isNotReady(error)) {
          dispatch({ type: 'transport_failed', failure: 'not_ready' })
          // El panel relee su estado y muestra la preparación real.
          void queryClient.invalidateQueries({
            queryKey: salesAssistantKeys.me(userId),
          })
        } else if (!abort.signal.aborted && isRestarting(error)) {
          dispatch({ type: 'transport_failed', failure: 'restarting' })
        } else if (!abort.signal.aborted) {
          dispatch({ type: 'transport_failed' })
        }
      } finally {
        if (controller.current === abort) controller.current = null
      }
    },
    [
      sessionId,
      createSession,
      syncBusiness,
      syncHistory,
      queryClient,
      userId,
      salesAssistantKeys,
      streamSalesAssistantTurn,
    ]
  )

  const retry = useCallback(async () => {
    if (lastText.current) await send(lastText.current)
  }, [send])

  return {
    history: messages.data?.messages ?? [],
    historyStatus: resolveHistoryStatus(sessionId, messages),
    turn,
    canSend: me.data?.status === 'ready' && turn.phase !== 'streaming',
    send,
    retry,
  }
}

function resolveHistoryStatus(
  sessionId: string | null,
  query: { data?: unknown; error: unknown }
): SalesAssistantChat['historyStatus'] {
  if (sessionId === null || query.data) return 'ready'
  if (query.error) return 'error'
  return 'loading'
}
