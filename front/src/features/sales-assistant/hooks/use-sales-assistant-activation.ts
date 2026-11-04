'use client'

import { useAssistantRuntime } from '../runtime'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  claimAccessRecovery,
  clearActivationKey,
  getOrCreateActivationKey,
  hasActivationKey,
} from '../lib/activation-key'
import type {
  SalesAssistantMe,
  SalesAssistantStatus,
  SalesAssistantStep,
} from '../types'
import { useSalesAssistantUserId } from './use-sales-assistant-me'
import { useActivateSalesAssistantMutation } from './use-sales-assistant-mutations'

function assignLocation(url: string): void {
  window.location.assign(url)
}

/** «Preparando tu acceso»: falta el salto SSO (primera vez o recuperación). */
function needsAccess(
  status: SalesAssistantStatus | undefined,
  step: SalesAssistantStep | null | undefined
): boolean {
  return status === 'activating' && step === 'preparing_access'
}

/**
 * Libera la `Idempotency-Key` en cuanto el asistente existe (`status ≠ none`).
 * Lo monta el panel en todos sus estados, así una activación nueva después de
 * borrar nunca reutiliza la clave anterior. Mientras la primera activación
 * espera el acceso (`preparing_access`) la conserva: así la recuperación
 * silenciosa (OCB-009) la distingue y no lanza otro salto SSO.
 */
export function useReleaseActivationKey(
  status: SalesAssistantStatus | undefined,
  step?: SalesAssistantStep | null
): void {
  const { storageNamespace } = useAssistantRuntime()
  const userId = useSalesAssistantUserId()
  const waitingAccess = needsAccess(status, step)
  useEffect(() => {
    if (userId && status && status !== 'none' && !waitingAccess)
      clearActivationKey(userId, storageNamespace)
  }, [userId, status, waitingAccess, storageNamespace])
}

/**
 * Recuperación silenciosa del acceso (OCB-009). Si `GET /me` dice «Preparando
 * tu acceso» para un asistente que ya existía (no hay clave de la primera
 * activación) llama una vez a `POST /activation` con una key nueva y navega a
 * la `authorize_url` (`prompt=none`): el dueño no hace nada. Como mucho un
 * intento por montaje y uno cada 10 min por usuario. Si responde un estado o
 * falla, no hace nada: el polling de `/me` sigue mostrando el estado real.
 */
export function useSalesAssistantAccessRecovery(
  me: SalesAssistantMe | undefined,
  navigate: (url: string) => void = assignLocation
): void {
  const { storageNamespace } = useAssistantRuntime()
  const userId = useSalesAssistantUserId()
  const { mutate } = useActivateSalesAssistantMutation()
  const attempted = useRef(false)
  const waitingAccess = needsAccess(me?.status, me?.step)

  useEffect(() => {
    if (!userId || !waitingAccess || attempted.current) return
    if (
      hasActivationKey(userId, storageNamespace) ||
      !claimAccessRecovery(userId, storageNamespace)
    )
      return
    attempted.current = true
    mutate(crypto.randomUUID(), {
      onSuccess: data => {
        if ('authorize_url' in data) navigate(data.authorize_url)
      },
    })
  }, [userId, waitingAccess, mutate, navigate, storageNamespace])
}

/**
 * Activación en un clic (OCF-003). Un solo POST aunque haya doble clic o
 * recarga (misma `Idempotency-Key` por usuario hasta que el asistente exista).
 * Con `authorize_url` navega al acceso: el navegador vuelve solo al panel por
 * el callback del BFF, y el botón sigue ocupado mientras tanto.
 */
export function useSalesAssistantActivation(
  navigate: (url: string) => void = assignLocation
) {
  const { storageNamespace } = useAssistantRuntime()
  const userId = useSalesAssistantUserId()
  const mutation = useActivateSalesAssistantMutation()
  const inFlight = useRef(false)
  const [redirecting, setRedirecting] = useState(false)

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      inFlight.current = false
      setRedirecting(false)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  const activate = useCallback(() => {
    if (!userId || inFlight.current) return
    inFlight.current = true
    mutation.mutate(getOrCreateActivationKey(userId, storageNamespace), {
      onSuccess: data => {
        if (!('authorize_url' in data)) return
        setRedirecting(true)
        navigate(data.authorize_url)
      },
      onSettled: (data, error) => {
        if (error || (data && !('authorize_url' in data)))
          inFlight.current = false
      },
    })
  }, [userId, mutation, navigate, storageNamespace])

  return {
    activate,
    isBusy: mutation.isPending || redirecting,
    error: mutation.error,
  }
}
