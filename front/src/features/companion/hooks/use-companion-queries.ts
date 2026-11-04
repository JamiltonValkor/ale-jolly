'use client'

import { useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  PAIRING_TIMINGS,
  type DemoSignal,
  type PairingTransport,
} from '../lib/pairing-transport'
import type { ClaimRequest, CompanionStatus } from '../types/pairing.schemas'
import { usePairingTransport } from './use-pairing-transport'

export const companionKeys = {
  all: ['companion'] as const,
  status: (kind: PairingTransport['kind']) =>
    ['companion', kind, 'status'] as const,
  robot: (kind: PairingTransport['kind'], pairingId: string | null) =>
    ['companion', kind, 'robot', pairingId] as const,
}

/**
 * GET /api/meta-assistant/companion. Mientras sincroniza, consulta cada segundo.
 * `transport` es para leerlo fuera de un `PairingTransportProvider`.
 */
export function useCompanionStatus({
  enabled = true,
  syncing = false,
  transport: explicit,
}: {
  enabled?: boolean
  syncing?: boolean
  transport?: PairingTransport
}) {
  const fromContext = usePairingTransport()
  const transport = explicit ?? fromContext
  // El transporte llega por contexto y hay uno por app para cada `kind`: ese
  // discriminador va en la clave en lugar del objeto (no serializable).
  const getCompanion = useCallback(() => transport.getCompanion(), [transport])
  return useQuery({
    queryKey: companionKeys.status(transport.kind),
    queryFn: getCompanion,
    enabled,
    staleTime: syncing ? 0 : 10_000,
    gcTime: 5 * 60_000,
    refetchInterval: syncing
      ? transport.kind === 'demo'
        ? 500
        : PAIRING_TIMINGS.ownerPollSyncingMs
      : false,
    retry: 1,
  })
}

/** POST /api/meta-assistant/companion/claim */
export function useClaimCompanionMutation() {
  const transport = usePairingTransport()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ClaimRequest) => transport.claim(input),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: companionKeys.status(transport.kind),
      }),
  })
}

/** DELETE /api/meta-assistant/companion */
export function useUnpairCompanionMutation() {
  const transport = usePairingTransport()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => transport.unpair(),
    onSuccess: () => {
      const key = companionKeys.status(transport.kind)
      queryClient.setQueryData<CompanionStatus>(key, {
        paired: false,
        device: null,
      })
      return queryClient.invalidateQueries({ queryKey: key })
    },
  })
}

/**
 * Solo demo: escucha a las otras pestañas. Los cambios refrescan las
 * consultas del compañero al instante; «hola» llega a quien lo pida.
 */
export function useTransportSignals(
  onSignal?: (signal: DemoSignal) => void,
  explicit?: PairingTransport
) {
  const fromContext = usePairingTransport()
  const transport = explicit ?? fromContext
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!transport.subscribe) return
    return transport.subscribe(signal => {
      if (signal === 'changed') {
        void queryClient.invalidateQueries({ queryKey: companionKeys.all })
      }
      onSignal?.(signal)
    })
  }, [transport, queryClient, onSignal])
}
