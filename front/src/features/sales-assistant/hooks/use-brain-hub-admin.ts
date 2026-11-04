'use client'

import { useAssistantRuntime, useAssistantFeatureEnabled } from '../runtime'

import { useRef, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PublishRequest } from '../types'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

/** Buzón admin del Cerebro SaleADS (OSF-005). La lista blanca vive en el servidor (403 = no disponible). */

function useAdminKey() {
  const { keys: salesAssistantKeys } = useAssistantRuntime()
  const enabled = useAssistantFeatureEnabled()
  const userId = useSalesAssistantUserId()
  const base = salesAssistantKeys.brainHubAdmin(userId ?? 'anonymous')
  return { base, enabled: enabled && userId !== null }
}

export function useAdminLessons() {
  const {
    orqa: { fetchAdminLessons },
  } = useAssistantRuntime()
  const { base, enabled } = useAdminKey()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) => fetchAdminLessons(signal),
    [fetchAdminLessons]
  )
  return useQuery({
    queryKey: [...base, 'lessons'],
    queryFn,
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  })
}

export function useAdminCatalog() {
  const {
    orqa: { fetchAdminCatalog },
  } = useAssistantRuntime()
  const { base, enabled } = useAdminKey()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) => fetchAdminCatalog(signal),
    [fetchAdminCatalog]
  )
  return useQuery({
    queryKey: [...base, 'catalog'],
    queryFn,
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  })
}

function useInvalidateAdmin() {
  const queryClient = useQueryClient()
  const { base } = useAdminKey()
  return () => queryClient.invalidateQueries({ queryKey: base })
}

export function useReviewLesson() {
  const {
    orqa: { reviewAdminLesson },
  } = useAssistantRuntime()
  const invalidate = useInvalidateAdmin()
  return useMutation({
    mutationFn: ({
      lessonId,
      action,
    }: {
      lessonId: string
      action: 'validate' | 'reject'
    }) => reviewAdminLesson(lessonId, action),
    onSettled: invalidate,
  })
}

/** Un solo POST por publicación: la key se reusa hasta que el intento termine. */
export function usePublishLesson() {
  const {
    orqa: { publishAdminLesson },
  } = useAssistantRuntime()
  const invalidate = useInvalidateAdmin()
  const keys = useRef(new Map<string, string>())
  return useMutation({
    mutationFn: ({
      lessonId,
      input,
    }: {
      lessonId: string
      input: PublishRequest
    }) => {
      const key = keys.current.get(lessonId) ?? crypto.randomUUID()
      keys.current.set(lessonId, key)
      return publishAdminLesson(lessonId, input, key)
    },
    onSuccess: (_data, { lessonId }) => keys.current.delete(lessonId),
    onSettled: invalidate,
  })
}

export function useRetireCatalogItem() {
  const {
    orqa: { retireCatalogItem },
  } = useAssistantRuntime()
  const invalidate = useInvalidateAdmin()
  return useMutation({
    mutationFn: (itemId: string) => retireCatalogItem(itemId),
    onSettled: invalidate,
  })
}
