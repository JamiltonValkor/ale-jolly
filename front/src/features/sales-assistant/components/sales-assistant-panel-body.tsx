'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  useReleaseActivationKey,
  useSalesAssistantAccessRecovery,
} from '../hooks/use-sales-assistant-activation'
import { useSalesAssistantMe } from '../hooks/use-sales-assistant-me'
import { useSalesAssistantTimezoneSync } from '../hooks/use-sales-assistant-timezone-sync'
import { useBusinessTypeSync } from '../hooks/use-business-type-sync'
import { salesAssistantErrorKey } from '../lib/error-messages'
import { resolveSalesAssistantView } from '../lib/panel-view'
import type { SalesAssistantMe } from '../types'
import { useAssistantRuntime } from '../runtime'
import { ActivationProgress } from './activation-progress'
import { ActivationStart } from './activation-start'
import { LifecycleActions } from './lifecycle-actions'
import { SalesAssistantTabs } from './sales-assistant-tabs'
import { StatusNotice } from './status-notice'

export interface SalesAssistantPanelSlots {
  /** Formulario «Configura tu IA» (OCF-004) cuando `step=configure_ai`. */
  configureAiSlot?: ReactNode
  /** Chat (OCF-005) cuando el asistente está listo. */
  chatSlot?: ReactNode
  /** Mi cerebro (ORQA OSF-001), en `ready` y en `stopped` (última foto). */
  brainSlot?: ReactNode
  /** Habilidades y compartir lecciones (ORQA OSF-004). */
  skillsSlot?: ReactNode
  /** Límites del equipo autónomo (AAF-004), en `ready` y `stopped`. */
  limitsSlot?: ReactNode
  /** Lo que hizo el equipo autónomo (AAF-005), en `ready` y `stopped`. */
  activitySlot?: ReactNode
}

interface Props extends SalesAssistantPanelSlots {
  className?: string
}

function PanelLoading() {
  const t = useTranslations('salesAssistant.status')
  return (
    <div
      role="status"
      aria-label={t('loading')}
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-32 w-full rounded-[var(--sa-card-radius)]" />
    </div>
  )
}

function PanelError({ error }: { error: Error }) {
  const t = useTranslations('salesAssistant')
  return (
    <p role="alert" className="text-sa-text-secondary text-sm">
      {t(salesAssistantErrorKey(error))}
    </p>
  )
}

function PanelView({
  data,
  configureAiSlot,
  chatSlot,
  brainSlot,
  skillsSlot,
  limitsSlot,
  activitySlot,
}: SalesAssistantPanelSlots & { data: SalesAssistantMe }) {
  const { managedAi } = useAssistantRuntime()
  const view = resolveSalesAssistantView(data)
  switch (view) {
    case 'activate':
      return <ActivationStart />
    case 'preparing':
    case 'failed':
      return (
        <ActivationProgress
          step={data.step}
          slow={data.slow}
          failed={view === 'failed'}
        />
      )
    case 'configureAi':
      return (
        <>
          <ActivationProgress step="configure_ai" slow={false} failed={false} />
          {!managedAi && configureAiSlot}
          <LifecycleActions view="configureAi" />
        </>
      )
    case 'ready':
      return (
        <>
          <SalesAssistantTabs
            chat={chatSlot ?? <StatusNotice kind="ready" />}
            brain={brainSlot}
            skills={skillsSlot}
            limits={limitsSlot}
            activity={activitySlot}
          />
          {/* Cambiar proveedor, modelo o key sin borrar el asistente (PUT /ai ya lo soporta). */}
          {!managedAi && configureAiSlot}
          <LifecycleActions view="ready" />
        </>
      )
    case 'stopped':
      return (
        <>
          <StatusNotice kind="stopped" />
          <SalesAssistantTabs
            chat={null}
            brain={brainSlot}
            skills={skillsSlot}
            limits={limitsSlot}
            activity={activitySlot}
            chatDisabled
          />
          <LifecycleActions view="stopped" />
        </>
      )
    default:
      return <StatusNotice kind="deleting" />
  }
}

/**
 * Cuerpo del panel «Mi asistente»: elige la vista según `GET /me` (OCF-003 y
 * OCF-006). El polling lo hace `useSalesAssistantMe`, así que el panel
 * cambia solo al avanzar la preparación o terminar el borrado. Si un
 * asistente existente pierde el acceso, lo recupera solo (OCB-009), y si su
 * zona horaria no es la del navegador, la sincroniza en silencio (OCB-016).
 */
export function SalesAssistantPanelBody({ className, ...slots }: Props) {
  const { data, error } = useSalesAssistantMe()
  useReleaseActivationKey(data?.status, data?.step)
  useSalesAssistantAccessRecovery(data)
  useSalesAssistantTimezoneSync(data)
  useBusinessTypeSync(data?.status)
  let content: ReactNode
  if (data) content = <PanelView data={data} {...slots} />
  else if (error) content = <PanelError error={error} />
  else content = <PanelLoading />
  return (
    <div className={cn('mt-8 flex flex-col gap-6', className)}>{content}</div>
  )
}
