'use client'

import { useCallback, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isStockGoneError } from '../lib/stock-error'
import { useAssistantRuntime } from '../runtime'
import {
  cancelStockOrder,
  changeStockAutonomy,
  decideStockProposal,
  fetchStockAutonomy,
  fetchStockItems,
  fetchStockOrders,
  fetchStockProposals,
  fetchStockStatus,
  fetchStockSummary,
  type StockDecisionInput,
  type StockLevelInput,
} from '../sdk/stock-client'
import type { StockOrders, StockStatusResponse } from '../types'
import { SalesAssistantClientError } from '../sdk/sales-assistant-client'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

/** Refresco de las vistas abiertas (IVF-003, 004 y 005). */
const POLL_MS = 20_000
const STATUS_RETRY_MS = 15_000
const LIVE_ORDERS = new Set(['aprobado', 'negociando', 'acordado', 'en_camino'])

/** Un 4xx no mejora reintentando; un 5xx o la red, sí. */
function retryRead(count: number, error: unknown): boolean {
  const status =
    error instanceof SalesAssistantClientError ? error.status : null
  return count < 1 && (status === null || status >= 500)
}

function useStockUser() {
  const { keys } = useAssistantRuntime()
  return { keys, userId: useSalesAssistantUserId() ?? 'anonymous' }
}

function selectStatus(response: StockStatusResponse) {
  return response.available && response.data.enabled ? response.data : null
}

/**
 * `null`: apagado o usuario no habilitado. Con error conserva el último valor y,
 * sin valor previo, reintenta: un 503 pasajero no pierde un enlace profundo.
 */
export function useStockStatus() {
  const { keys, userId } = useStockUser()
  return useQuery({
    queryKey: keys.stockStatus(userId),
    queryFn: ({ signal }) => fetchStockStatus(signal),
    select: selectStatus,
    staleTime: 60_000,
    retry: retryRead,
    refetchInterval: query =>
      query.state.status === 'error' ? STATUS_RETRY_MS : false,
  })
}

const LIVE_READ = {
  staleTime: 5_000,
  retry: retryRead,
  refetchInterval: POLL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
} as const

/** `enabled` en falso cuando Stock no está habilitado (la oficina lo llama siempre). */
export function useStockSummary(businessId: string, enabled = true) {
  const { keys, userId } = useStockUser()
  return useQuery({
    ...LIVE_READ,
    queryKey: keys.stockSummary(userId, businessId),
    queryFn: ({ signal }) => fetchStockSummary(businessId, signal),
    enabled: enabled && !!businessId,
  })
}

export function useStockItems(businessId: string) {
  const { keys, userId } = useStockUser()
  return useQuery({
    ...LIVE_READ,
    queryKey: keys.stockItems(userId, businessId),
    queryFn: ({ signal }) => fetchStockItems(businessId, signal),
  })
}

export function useStockProposals(businessId: string) {
  const { keys, userId } = useStockUser()
  return useQuery({
    ...LIVE_READ,
    queryKey: keys.stockProposals(userId, businessId),
    queryFn: ({ signal }) => fetchStockProposals(businessId, signal),
  })
}

/** Solo un pedido en curso sigue refrescando: `recibido` y `cancelado` no cambian. */
export const stockOrdersPoll = (orders: StockOrders | undefined) =>
  orders?.pedidos.some(order => LIVE_ORDERS.has(order.estado)) ? POLL_MS : false

export function useStockOrders(businessId: string) {
  const { keys, userId } = useStockUser()
  return useQuery({
    ...LIVE_READ,
    queryKey: keys.stockOrders(userId, businessId),
    queryFn: ({ signal }) => fetchStockOrders(businessId, signal),
    refetchInterval: query => stockOrdersPoll(query.state.data),
  })
}

export function useStockAutonomy(businessId: string) {
  const { keys, userId } = useStockUser()
  return useQuery({
    staleTime: 30_000,
    retry: retryRead,
    queryKey: keys.stockAutonomy(userId, businessId),
    queryFn: ({ signal }) => fetchStockAutonomy(businessId, signal),
  })
}

function useInvalidateStock(businessId: string) {
  const { keys, userId } = useStockUser()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [
          keys.stockSummary(userId, businessId),
          keys.stockItems(userId, businessId),
          keys.stockProposals(userId, businessId),
          keys.stockOrders(userId, businessId),
          keys.stockAutonomy(userId, businessId),
        ].map(queryKey => queryClient.invalidateQueries({ queryKey }))
      ),
    [businessId, keys, queryClient, userId]
  )
}

/**
 * Una clave por intento: reintentar la reusa, cambiar un campo crea otra. Se
 * borra solo tras éxito o al cerrar el diálogo: si se borrara al fallar, un
 * reintento tras una escritura hecha daría «ya se resolvió» sobre lo propio.
 */
function useAttemptKeys() {
  const keys = useRef(new Map<string, string>())
  const keyFor = useCallback((attempt: unknown) => {
    const id = JSON.stringify(attempt)
    const key = keys.current.get(id) ?? crypto.randomUUID()
    keys.current.set(id, key)
    return { id, key }
  }, [])
  const forget = useCallback((id: string) => keys.current.delete(id), [])
  const clear = useCallback(() => keys.current.clear(), [])
  return { keyFor, forget, clear }
}

export function useDecideStockProposal(businessId: string) {
  const invalidate = useInvalidateStock(businessId)
  const { keyFor, forget, clear } = useAttemptKeys()
  const attempt = ({
    proposalId,
    revision,
    decision,
    causa,
    motivo,
    reparto,
  }: StockDecisionInput) =>
    keyFor([
      proposalId,
      revision,
      decision,
      causa ?? null,
      motivo ?? null,
      reparto ?? null,
    ])
  const mutation = useMutation({
    mutationFn: (input: StockDecisionInput) =>
      decideStockProposal(businessId, input, attempt(input).key),
    onSuccess: (_proposal, input) => {
      forget(attempt(input).id)
      void invalidate()
    },
    onError: error => {
      if (isStockGoneError(error)) void invalidate()
    },
  })
  return { ...mutation, clearAttempts: clear }
}

export function useChangeStockAutonomy(businessId: string) {
  const invalidate = useInvalidateStock(businessId)
  const { keyFor, forget, clear } = useAttemptKeys()
  const attempt = ({ area, revision, nivel, motivo }: StockLevelInput) =>
    keyFor([area, revision, nivel, motivo ?? null])
  const mutation = useMutation({
    mutationFn: (input: StockLevelInput) =>
      changeStockAutonomy(businessId, input, attempt(input).key),
    onSuccess: (_area, input) => {
      forget(attempt(input).id)
      void invalidate()
    },
    onError: error => {
      if (isStockGoneError(error)) void invalidate()
    },
  })
  return { ...mutation, clearAttempts: clear }
}

/** El dueño corta una negociación. El servicio no le avisa al proveedor. */
export function useCancelStockOrder(businessId: string) {
  const invalidate = useInvalidateStock(businessId)
  return useMutation({
    mutationFn: (orderId: string) => cancelStockOrder(businessId, orderId),
    onSuccess: () => void invalidate(),
    onError: error => {
      if (isStockGoneError(error)) void invalidate()
    },
  })
}
