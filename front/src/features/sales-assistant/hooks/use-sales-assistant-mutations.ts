'use client'

import { useAssistantRuntime } from '../runtime'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { browserTimezone } from '../lib/browser-timezone'
import type { SalesAssistantAiInput } from '../sdk/sales-assistant-client'
import type { SalesAssistantMe } from '../types'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

function useMeKey() {
  const { keys: salesAssistantKeys } = useAssistantRuntime()
  return salesAssistantKeys.me(useSalesAssistantUserId() ?? 'anonymous')
}

/** Mutación que responde el estado actual: lo escribe directo en `/me`. */
function useStateMutation(mutationFn: () => Promise<SalesAssistantMe>) {
  const queryClient = useQueryClient()
  const meKey = useMeKey()
  return useMutation({
    mutationFn,
    onSuccess: data => queryClient.setQueryData(meKey, data),
  })
}

/**
 * `POST /activation` con `Idempotency-Key` y la zona del navegador (OCB-016),
 * tanto en la primera activación como en la recuperación silenciosa. Con
 * `authorize_url` el componente navega (OCF-003); si el asistente ya existe,
 * llega su estado.
 */
export function useActivateSalesAssistantMutation() {
  const {
    client: { requestSalesAssistantActivation },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const meKey = useMeKey()
  return useMutation({
    mutationFn: (idempotencyKey: string) =>
      requestSalesAssistantActivation(idempotencyKey, browserTimezone()),
    onSuccess: data => {
      if (!('authorize_url' in data)) queryClient.setQueryData(meKey, data)
    },
  })
}

/**
 * `PUT /ai`. La key viaja en un `OneShotSecret` que el SDK consume al armar
 * el cuerpo: ni `variables` ni el cache conservan su valor (`gcTime: 0`).
 * Con `ok` se invalida `/me` para habilitar el chat sin recargar.
 */
export function useConfigureSalesAssistantAiMutation() {
  const {
    client: { configureSalesAssistantAi },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const meKey = useMeKey()
  return useMutation({
    mutationFn: (input: SalesAssistantAiInput) =>
      configureSalesAssistantAi(input),
    gcTime: 0,
    onSuccess: data => {
      if (data.result === 'ok')
        void queryClient.invalidateQueries({ queryKey: meKey })
    },
  })
}

export function useCreateSalesAssistantSessionMutation() {
  const {
    client: { createSalesAssistantSession },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const meKey = useMeKey()
  return useMutation({
    mutationFn: () => createSalesAssistantSession(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meKey }),
  })
}

/** `PUT /timezone` (OCB-016): responde el estado y lo escribe en `/me`. */
export function useUpdateSalesAssistantTimezoneMutation() {
  const {
    client: { updateSalesAssistantTimezone },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const meKey = useMeKey()
  return useMutation({
    mutationFn: (timezone: string) => updateSalesAssistantTimezone(timezone),
    onSuccess: data => queryClient.setQueryData(meKey, data),
  })
}

export function useStopSalesAssistantMutation() {
  const {
    client: { stopSalesAssistant },
  } = useAssistantRuntime()
  return useStateMutation(stopSalesAssistant)
}

export function useStartSalesAssistantMutation() {
  const {
    client: { startSalesAssistant },
  } = useAssistantRuntime()
  return useStateMutation(startSalesAssistant)
}

/** `DELETE /me` es asíncrono: devuelve `deleting` y el panel sondea (OCF-006). */
export function useDeleteSalesAssistantMutation() {
  const {
    client: { deleteSalesAssistant },
  } = useAssistantRuntime()
  return useStateMutation(deleteSalesAssistant)
}
