'use client'

import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { autonomousTeamKeys } from '../lib/query-keys'
import {
  updateAgentBudget,
  updateAgentCreditCap,
  type AgentBudgetUpdateInput,
  type AssistantBffPrefix,
} from '../sdk/autonomous-team-client'
import { useAutonomousTeamUserId } from './use-autonomous-team-queries'

/**
 * Una `Idempotency-Key` por guardado: el mismo contenido reusa la clave en un
 * doble clic o un reintento; un contenido nuevo (o un guardado ya hecho) la
 * renueva.
 */
function useSaveKey() {
  const current = useRef<{ payload: string; key: string } | null>(null)
  return {
    keyFor(payload: unknown) {
      const serialized = JSON.stringify(payload)
      if (current.current?.payload !== serialized)
        current.current = { payload: serialized, key: crypto.randomUUID() }
      return current.current.key
    },
    reset() {
      current.current = null
    },
  }
}

export function useUpdateAgentBudget(
  businessId: string,
  assistantBffPrefix?: AssistantBffPrefix
) {
  const queryClient = useQueryClient()
  const userId = useAutonomousTeamUserId() ?? 'anonymous'
  const saveKey = useSaveKey()
  const queryKey = autonomousTeamKeys.budget(
    userId,
    businessId,
    assistantBffPrefix
  )
  return useMutation({
    mutationFn: (input: AgentBudgetUpdateInput) =>
      assistantBffPrefix
        ? updateAgentBudget(
            businessId,
            input,
            saveKey.keyFor(input),
            assistantBffPrefix
          )
        : updateAgentBudget(businessId, input, saveKey.keyFor(input)),
    onSuccess: budget => {
      saveKey.reset()
      queryClient.setQueryData(queryKey, budget)
    },
    // 412 (cambió mientras editabas) u otro error: se relee el valor real.
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  })
}

export function useUpdateAgentCreditCap() {
  const queryClient = useQueryClient()
  const userId = useAutonomousTeamUserId() ?? 'anonymous'
  const saveKey = useSaveKey()
  const queryKey = autonomousTeamKeys.creditCap(userId)
  return useMutation({
    mutationFn: (cap: number) => updateAgentCreditCap(cap, saveKey.keyFor(cap)),
    onSuccess: view => {
      saveKey.reset()
      queryClient.setQueryData(queryKey, view)
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  })
}
