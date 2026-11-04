'use client'

import { useCallback } from 'react'

import { useAssistantRuntime, useAssistantFeatureEnabled } from '../runtime'

import { useQuery } from '@tanstack/react-query'
import { SalesAssistantClientError } from '../sdk/sales-assistant-client'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

/** Lecturas de ORQA del dueño (OSF-001/003/004). Con la bandera apagada no se llama al BFF. */

const TIMELINE_LIMIT = 20

/** Un 404 (sin fotos, negocio ajeno) es una respuesta, no un fallo: no se reintenta. */
function retryUnlessNotFound(failureCount: number, error: unknown): boolean {
  if (error instanceof SalesAssistantClientError && error.code === 'NOT_FOUND')
    return false
  return failureCount < 1
}

function useOrqaGate(): string | null {
  const enabledByFlag = useAssistantFeatureEnabled()
  const userId = useSalesAssistantUserId()
  return enabledByFlag ? userId : null
}

/** Línea de tiempo de fotos del cerebro del negocio (la más nueva primero). */
export function useBrainSnapshots(businessId: string | null) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchBrainSnapshots },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchBrainSnapshots(businessId!, TIMELINE_LIMIT, signal),
    [fetchBrainSnapshots, businessId]
  )
  return useQuery({
    queryKey: salesAssistantKeys.brainSnapshots(
      userId ?? 'anonymous',
      businessId ?? 'none'
    ),
    queryFn,
    enabled: userId !== null && businessId !== null,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: retryUnlessNotFound,
  })
}

/** Una foto (versión) del cerebro; las fotos no cambian, se cachean largo. */
export function useBrainSnapshot(
  businessId: string | null,
  version: number | null
) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchBrainSnapshot },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchBrainSnapshot(businessId!, version!, signal),
    [fetchBrainSnapshot, businessId, version]
  )
  return useQuery({
    queryKey: salesAssistantKeys.brainSnapshot(
      userId ?? 'anonymous',
      businessId ?? 'none',
      version ?? 0
    ),
    queryFn,
    enabled: userId !== null && businessId !== null && version !== null,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}

export function useApproval(approvalId: string) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchApproval },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) => fetchApproval(approvalId, signal),
    [fetchApproval, approvalId]
  )
  return useQuery({
    queryKey: salesAssistantKeys.approval(userId ?? 'anonymous', approvalId),
    queryFn,
    enabled: userId !== null,
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: false,
  })
}

export function useSkillCatalog(businessId: string | null) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchSkillCatalog },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchSkillCatalog(businessId!, signal),
    [fetchSkillCatalog, businessId]
  )
  return useQuery({
    queryKey: salesAssistantKeys.skillCatalog(
      userId ?? 'anonymous',
      businessId ?? 'none'
    ),
    queryFn,
    enabled: userId !== null && businessId !== null,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  })
}

/** Foto en forma v2 para «Mi cerebro» por secciones (MLF-002); cae a v1 si el servicio no la tiene. */
export function useBrainSnapshotV2(
  businessId: string | null,
  version: number | null
) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchBrainSnapshotV2 },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchBrainSnapshotV2(businessId!, version!, signal),
    [fetchBrainSnapshotV2, businessId, version]
  )
  return useQuery({
    queryKey: salesAssistantKeys.brainSnapshotV2(
      userId ?? 'anonymous',
      businessId ?? 'none',
      version ?? 0
    ),
    queryFn,
    enabled: userId !== null && businessId !== null && version !== null,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}

/** «Qué cambió» entre dos fotos (MLF-003). Un 404 = el servicio aún no compara. */
export function useBrainDiff(
  businessId: string | null,
  from: number | null,
  to: number | null
) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchBrainDiff },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchBrainDiff(businessId!, from!, to!, signal),
    [fetchBrainDiff, businessId, from, to]
  )
  return useQuery({
    queryKey: salesAssistantKeys.brainDiff(
      userId ?? 'anonymous',
      businessId ?? 'none',
      from ?? 0,
      to ?? 0
    ),
    queryFn,
    enabled:
      userId !== null &&
      businessId !== null &&
      from !== null &&
      to !== null &&
      from !== to,
    staleTime: Infinity,
    retry: retryUnlessNotFound,
  })
}

/** Tipo de negocio (MLF-001). Un 503 se trata como «elige» y nunca bloquea el panel. */
export function useBusinessProfile(businessId: string | null) {
  const {
    keys: salesAssistantKeys,
    orqa: { fetchBusinessProfile },
  } = useAssistantRuntime()
  const userId = useOrqaGate()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      fetchBusinessProfile(businessId!, signal),
    [fetchBusinessProfile, businessId]
  )
  return useQuery({
    queryKey: salesAssistantKeys.businessProfile(
      userId ?? 'anonymous',
      businessId ?? 'none'
    ),
    queryFn,
    enabled: userId !== null && businessId !== null,
    staleTime: 5 * 60_000,
    retry: false,
  })
}
