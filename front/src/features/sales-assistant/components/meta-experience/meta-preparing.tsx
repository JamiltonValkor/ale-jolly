'use client'

import { useEffect, useState } from 'react'
import { useBusinessStore } from '@/store/use-business-store'
import { useSalesAssistantActivation } from '../../hooks/use-sales-assistant-activation'
import { preparingAlert } from '../../lib/meta-experience/preparing-alert'
import type { SalesAssistantStep } from '../../types'
import { MetaPreparingView } from './meta-preparing-view'
import type { RenderCompanion } from './types'

interface Props {
  step: SalesAssistantStep | null
  slow: boolean
  failed: boolean
  onCheckAgain: () => void
  renderCompanion?: RenderCompanion
}

/** Reloj de la pantalla: cuánto lleva en total y en el paso actual. */
function useStepClock(step: SalesAssistantStep | null) {
  const [now, setNow] = useState(() => Date.now())
  const [mountedAt] = useState(now)
  const [stepSince, setStepSince] = useState({ step, at: now })
  // Estado derivado: al cambiar de paso, el reloj del paso arranca de nuevo.
  if (stepSince.step !== step) setStepSince({ step, at: now })
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  return {
    elapsedMinutes: Math.floor((now - mountedAt) / 60_000),
    msAtStep: now - stepSince.at,
  }
}

/**
 * Preparación conectada: si el acceso se traba (o la vuelta al acceso falla),
 * «Reintentar conexión» vuelve a pedir el acceso con la misma activación.
 */
export function MetaPreparing({
  step,
  slow,
  failed,
  onCheckAgain,
  renderCompanion,
}: Props) {
  const business = useBusinessStore(state => state.selectedBusiness)
  const { activate, isBusy, error } = useSalesAssistantActivation()
  const { elapsedMinutes, msAtStep } = useStepClock(step)
  return (
    <MetaPreparingView
      businessName={business?.business_name ?? null}
      step={step}
      failed={failed}
      alert={preparingAlert({
        step,
        slow,
        msAtStep,
        activationFailed: Boolean(error),
      })}
      elapsedMinutes={elapsedMinutes}
      onRetryAccess={activate}
      retrying={isBusy}
      onCheckAgain={onCheckAgain}
      renderCompanion={renderCompanion}
    />
  )
}
