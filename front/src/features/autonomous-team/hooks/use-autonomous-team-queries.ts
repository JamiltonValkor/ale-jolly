'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { autonomousTeamKeys } from '../lib/query-keys'
import { fetchAdAccountCurrency } from '../sdk/ad-account-currency'
import {
  fetchAgentAction,
  fetchAgentActions,
  fetchAgentBudget,
  fetchAgentCreditCap,
  fetchObjectAgentActions,
  type AgentObjectType,
  type AssistantBffPrefix,
} from '../sdk/autonomous-team-client'

/** Lecturas del equipo autónomo (AAF-001). `{available:false}` es un dato, no un error. */

export function useAutonomousTeamUserId(): string | null {
  const { data: session, status } = useSession()
  return status === 'authenticated' ? (session?.user?.id ?? null) : null
}

interface ActionsFilters {
  kind?: string
  campaignId?: string
  limit?: number
}

/** Traza del negocio, más reciente primero, paginada con «Ver más» (`next_cursor`). */
export function useAgentActions(
  businessId: string | null,
  filters: ActionsFilters = {}
) {
  const userId = useAutonomousTeamUserId()
  return useInfiniteQuery({
    queryKey: autonomousTeamKeys.actions(
      userId ?? 'anonymous',
      businessId ?? 'none',
      JSON.stringify(filters)
    ),
    queryFn: ({ pageParam, signal }) =>
      fetchAgentActions(businessId!, { ...filters, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page =>
      page.available ? (page.data.next_cursor ?? undefined) : undefined,
    enabled: userId !== null && businessId !== null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}

export function useAgentAction(actionId: string | null) {
  const userId = useAutonomousTeamUserId()
  return useQuery({
    queryKey: autonomousTeamKeys.action(
      userId ?? 'anonymous',
      actionId ?? 'none'
    ),
    queryFn: ({ signal }) => fetchAgentAction(actionId!, signal),
    enabled: userId !== null && actionId !== null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}

export function useObjectAgentActions(
  type: AgentObjectType,
  objectId: string | null
) {
  const userId = useAutonomousTeamUserId()
  return useQuery({
    queryKey: autonomousTeamKeys.objectActions(
      userId ?? 'anonymous',
      type,
      objectId ?? 'none'
    ),
    queryFn: ({ signal }) => fetchObjectAgentActions(type, objectId!, signal),
    enabled: userId !== null && objectId !== null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}

export function useAgentBudget(
  businessId: string | null,
  assistantBffPrefix?: AssistantBffPrefix
) {
  const userId = useAutonomousTeamUserId()
  return useQuery({
    queryKey: autonomousTeamKeys.budget(
      userId ?? 'anonymous',
      businessId ?? 'none',
      assistantBffPrefix
    ),
    queryFn: ({ signal }) =>
      assistantBffPrefix
        ? fetchAgentBudget(businessId!, signal, assistantBffPrefix)
        : fetchAgentBudget(businessId!, signal),
    enabled: userId !== null && businessId !== null,
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}

export function useAgentCreditCap(enabled = true) {
  const userId = useAutonomousTeamUserId()
  return useQuery({
    queryKey: autonomousTeamKeys.creditCap(userId ?? 'anonymous'),
    queryFn: ({ signal }) => fetchAgentCreditCap(signal),
    enabled: enabled && userId !== null,
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: 1,
  })
}

/** Moneda de la cuenta publicitaria verificada (V-F5); `null` = sin Meta conectado. */
export function useBudgetCurrency(businessId: string | null) {
  const userId = useAutonomousTeamUserId()
  return useQuery({
    queryKey: autonomousTeamKeys.budgetCurrency(
      userId ?? 'anonymous',
      businessId ?? 'none'
    ),
    queryFn: () => fetchAdAccountCurrency(businessId!),
    enabled: userId !== null && businessId !== null,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  })
}
