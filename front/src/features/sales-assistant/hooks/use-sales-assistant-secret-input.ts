'use client'

import { useCallback, useEffect, useRef } from 'react'
import { subscribeToSessionInvalidation } from '@/lib/auth/session-events'

/**
 * Campo de la key de IA no controlado (OCF-004, rescatado de
 * `native-inference-secret-entry`). La key vive solo en el `value` del input:
 * nunca en estado de React, props ni stores. `take()` la lee y vacía el campo
 * en el mismo paso, antes de que salga la petición. El campo también se vacía
 * al deshabilitarse, al cerrar sesión (en esta u otra pestaña) y al desmontarse.
 */
export function useSalesAssistantSecretInput(disabled: boolean) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const element = inputRef.current
    const clear = () => {
      if (element) element.value = ''
    }
    const unsubscribe = subscribeToSessionInvalidation(clear)
    return () => {
      unsubscribe()
      clear()
    }
  }, [])

  useEffect(() => {
    if (disabled && inputRef.current) inputRef.current.value = ''
  }, [disabled])

  const take = useCallback((): string | null => {
    const element = inputRef.current
    if (!element) return null
    const value = element.value.trim()
    element.value = ''
    return value.length > 0 ? value : null
  }, [])

  return { inputRef, take }
}
