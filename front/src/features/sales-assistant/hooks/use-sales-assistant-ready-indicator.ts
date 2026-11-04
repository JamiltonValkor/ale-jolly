'use client'

import { useAssistantRuntime } from '../runtime'

import { useEffect } from 'react'
import { shouldShowReadyIndicator } from '../lib/ready-indicator'
import {
  useSalesAssistantSeenStore,
  seenUserKey,
} from '../store/use-sales-assistant-seen-store'
import {
  useSalesAssistantMe,
  useSalesAssistantUserId,
} from './use-sales-assistant-me'

/** `true` cuando «Mi asistente» tiene un «listo» que el dueño no ha visto. */
export function useSalesAssistantReadyIndicator(): boolean {
  const { storageNamespace } = useAssistantRuntime()
  const { data } = useSalesAssistantMe()
  const userId = useSalesAssistantUserId()
  const lastSeen = useSalesAssistantSeenStore(state =>
    userId
      ? (state.lastSeenByUser[seenUserKey(userId, storageNamespace)] ?? null)
      : null
  )
  return userId !== null && shouldShowReadyIndicator(data, lastSeen)
}

/**
 * Se usa en el panel y en la pantalla Meta: mientras está abierto, todo «listo» que llegue queda
 * marcado como visto y apaga el indicador del sidebar.
 */
export function useMarkSalesAssistantSeen(): void {
  const { storageNamespace } = useAssistantRuntime()
  const { data } = useSalesAssistantMe()
  const userId = useSalesAssistantUserId()
  const markSeen = useSalesAssistantSeenStore(state => state.markSeen)
  const readySince = data?.ready_since ?? null

  useEffect(() => {
    if (userId && readySince) markSeen(userId, readySince, storageNamespace)
  }, [userId, readySince, markSeen, storageNamespace])
}
