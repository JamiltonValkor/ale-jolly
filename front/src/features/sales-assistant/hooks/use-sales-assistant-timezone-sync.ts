'use client'

import { useAssistantRuntime } from '../runtime'

import { useEffect } from 'react'
import {
  browserTimezone,
  claimTimezoneSync,
  shouldSyncTimezone,
} from '../lib/browser-timezone'
import type { SalesAssistantMe } from '../types'
import { useSalesAssistantUserId } from './use-sales-assistant-me'
import { useUpdateSalesAssistantTimezoneMutation } from './use-sales-assistant-mutations'

/**
 * Lleva la zona del navegador a un asistente que ya existe (OCB-016): si
 * `me.timezone` difiere, un `PUT /timezone` por sesión de navegador. Un back
 * viejo no manda `timezone` y no pasa nada. Es silencioso: si falla, el dueño
 * no ve nada y el servicio conserva su zona.
 */
export function useSalesAssistantTimezoneSync(
  me: SalesAssistantMe | undefined
): void {
  const { storageNamespace } = useAssistantRuntime()
  const userId = useSalesAssistantUserId()
  const { mutate } = useUpdateSalesAssistantTimezoneMutation()
  const browser = browserTimezone()
  const needsSync = shouldSyncTimezone(me, browser)

  useEffect(() => {
    if (!userId || !browser || !needsSync) return
    if (!claimTimezoneSync(userId, storageNamespace)) return
    mutate(browser)
  }, [userId, browser, needsSync, mutate, storageNamespace])
}
