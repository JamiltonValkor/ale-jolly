'use client'

import { useCallback } from 'react'

import { useAssistantRuntime, useAssistantFeatureEnabled } from '../runtime'

import { useQuery } from '@tanstack/react-query'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

/** Proveedores de IA (`GET /api/sales-assistant/providers`), orden del back. */
export function useSalesAssistantProviders() {
  const {
    managedAi,
    keys: salesAssistantKeys,
    client: { fetchSalesAssistantProviders },
  } = useAssistantRuntime()
  const enabledByFlag = useAssistantFeatureEnabled()
  const userId = useSalesAssistantUserId()

  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchSalesAssistantProviders(signal),
    [fetchSalesAssistantProviders]
  )
  return useQuery({
    queryKey: salesAssistantKeys.providers(userId ?? 'anonymous'),
    queryFn,
    enabled: enabledByFlag && !managedAi && userId !== null,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}

/**
 * Historial de la sesión (`GET .../sessions/{id}/messages`). `sessionId` sale
 * de `GET /me`; OCF-005 lo invalida al recibir `message_end`.
 */
export function useSalesAssistantMessages(sessionId: string | null) {
  const {
    keys: salesAssistantKeys,
    client: { fetchSalesAssistantMessages },
  } = useAssistantRuntime()
  const enabledByFlag = useAssistantFeatureEnabled()
  const userId = useSalesAssistantUserId()

  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchSalesAssistantMessages(sessionId!, signal),
    [fetchSalesAssistantMessages, sessionId]
  )
  return useQuery({
    queryKey: salesAssistantKeys.messages(
      userId ?? 'anonymous',
      sessionId ?? 'none'
    ),
    queryFn,
    enabled: enabledByFlag && userId !== null && sessionId !== null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}
