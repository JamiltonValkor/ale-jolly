'use client'

import { useId, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { useAssistantFeatureEnabled, useAssistantRuntime } from '../runtime'
import { useMarkSalesAssistantSeen } from '../hooks/use-sales-assistant-ready-indicator'
import {
  SalesAssistantPanelBody,
  type SalesAssistantPanelSlots,
} from './sales-assistant-panel-body'

interface Props extends SalesAssistantPanelSlots {
  className?: string
  /** Acción del encabezado: «Vincular mi compañero» (CR-005) en el agente Meta. */
  headerActionSlot?: ReactNode
}

/** Contenido del panel; se monta solo con la bandera activa. */
function SalesAssistantPanelContent({
  className,
  headerActionSlot,
  ...slots
}: Props) {
  const { managedAi } = useAssistantRuntime()
  const t = useTranslations(
    managedAi ? 'metaAssistant.panel' : 'salesAssistant.panel'
  )
  const titleId = useId()
  useMarkSalesAssistantSeen()
  return (
    <section
      aria-labelledby={titleId}
      className={cn('mx-auto w-full max-w-3xl pt-10 pb-10', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            id={titleId}
            className="text-sa-text-primary text-2xl font-semibold"
          >
            {t('title')}
          </h1>
          <p className="text-sa-text-secondary mt-2 text-sm">
            {t('description')}
          </p>
        </div>
        {headerActionSlot && <div className="shrink-0">{headerActionSlot}</div>}
      </div>
      <SalesAssistantPanelBody {...slots} />
    </section>
  )
}

/**
 * Panel «Mi asistente» (/{locale}/dashboard/assistant): activación y pasos
 * (OCF-003) y desactivar, reactivar y borrar (OCF-006). El formulario de IA
 * (OCF-004) y el chat (OCF-005) entran por `configureAiSlot` y `chatSlot`.
 * Sin la bandera no renderiza nada ni consulta el servicio; como PostHog carga
 * tarde, la página queda en blanco hasta que la bandera responde.
 */
export function SalesAssistantPanel({ className, ...slots }: Props) {
  const enabled = useAssistantFeatureEnabled()
  if (!enabled) return null
  return <SalesAssistantPanelContent className={className} {...slots} />
}
