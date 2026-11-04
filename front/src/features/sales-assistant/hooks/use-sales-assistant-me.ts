'use client'

import { useCallback } from 'react'

import { useAssistantRuntime, useAssistantFeatureEnabled } from '../runtime'

import { useQuery, type Query } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { salesAssistantPollInterval } from '../lib/ready-indicator'
import type { SalesAssistantMe } from '../types'

function isMetaPreparing(data: SalesAssistantMe | undefined): boolean {
  return (
    data?.status !== 'deleting' &&
    (data?.status === 'activating' || data?.step === 'configure_ai')
  )
}

const META_PREPARATION_OPTIONS = {
  refetchIntervalInBackground: true,
  refetchOnWindowFocus: (query: Query<SalesAssistantMe>) =>
    isMetaPreparing(query.state.data) ? ('always' as const) : false,
}

/** Usuario autenticado actual, o `null` mientras la sesión no está lista. */
export function useSalesAssistantUserId(): string | null {
  const { data: session, status } = useSession()
  return status === 'authenticated' ? (session?.user?.id ?? null) : null
}

/**
 * Estado del asistente del usuario (`GET /api/sales-assistant/me`).
 *
 * Con la bandera apagada la consulta queda deshabilitada: no sale ninguna
 * petición a `/api/sales-assistant/*`. Hace polling cada 30 s mientras
 * `status=activating` y cada 3 s mientras `status=deleting`. Meta consulta
 * cada 5 s durante preparación, incluso sin foco, y al recuperar el foco.
 */
export function useSalesAssistantMe() {
  const {
    id: runtimeId,
    keys: salesAssistantKeys,
    client: { fetchSalesAssistantMe },
  } = useAssistantRuntime()
  const enabledByFlag = useAssistantFeatureEnabled()
  const userId = useSalesAssistantUserId()

  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) => fetchSalesAssistantMe(signal),
    [fetchSalesAssistantMe]
  )
  return useQuery({
    queryKey: salesAssistantKeys.me(userId ?? 'anonymous'),
    queryFn,
    enabled: enabledByFlag && userId !== null,
    refetchInterval: query =>
      runtimeId === 'meta' && isMetaPreparing(query.state.data)
        ? 5_000
        : salesAssistantPollInterval(query.state.data),
    ...(runtimeId === 'meta' ? META_PREPARATION_OPTIONS : {}),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}
