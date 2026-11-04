'use client'

import { useAssistantRuntime } from '../runtime'

import { useEffect, useRef } from 'react'
import { useBusinessStore } from '@/store/use-business-store'
import { clearPendingType, readPendingType } from '../lib/business-type'
import type { SalesAssistantStatus } from '../types'

/**
 * La elección hecha antes de activar (MLF-001) se manda cuando el asistente
 * ya existe (estado distinto de `none`). Un fallo no bloquea: el dueño la ve
 * de nuevo en Habilidades.
 */
export function useBusinessTypeSync(status: SalesAssistantStatus | undefined) {
  const {
    storageNamespace,
    orqa: { updateBusinessProfile },
  } = useAssistantRuntime()
  const businessId = useBusinessStore(
    state => state.selectedBusiness?.business_id ?? null
  )
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (
      !businessId ||
      (status !== 'ready' && status !== 'stopped') ||
      sent.current === businessId
    )
      return
    const pending = readPendingType(businessId, storageNamespace)
    if (!pending) return
    sent.current = businessId
    updateBusinessProfile(businessId, pending)
      .then(() => clearPendingType(businessId, storageNamespace))
      .catch(() => {
        sent.current = null
      })
  }, [businessId, status, storageNamespace, updateBusinessProfile])
}
