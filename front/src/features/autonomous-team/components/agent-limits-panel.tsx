'use client'

import { useTranslations } from 'next-intl'
import { useReconciledBusinessId } from '@/hooks/queries'
import { AgentBudgetForm } from './agent-budget-form'
import { AgentCreditCapForm } from './agent-credit-cap-form'
import type { AssistantBffPrefix } from '../sdk/autonomous-team-client'

interface Props {
  /** Negocio activo; por defecto el seleccionado en la web. */
  businessId?: string | null
  assistantBffPrefix?: AssistantBffPrefix
  /** Quien la contiene ya pone título y descripción (Meta Assistant). */
  hideHeader?: boolean
}

/**
 * Pestaña «Límites» de «Mi asistente» (AAF-004): presupuesto mensual aprobado
 * del negocio (D23) y tope mensual de créditos del dueño (D15). Dentro de
 * ellos el equipo autónomo se mueve sin pedir permiso.
 */
export function AgentLimitsPanel({
  businessId,
  assistantBffPrefix,
  hideHeader = false,
}: Props) {
  const t = useTranslations('autonomousTeam.limits')
  const selected = useReconciledBusinessId()
  const business = businessId === undefined ? selected : businessId
  return (
    <div className="flex flex-col gap-4">
      {hideHeader ? null : (
        <div className="flex flex-col gap-1">
          <h2 className="text-sa-text-primary text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-sa-text-secondary text-sm">{t('description')}</p>
        </div>
      )}
      {business ? (
        <AgentBudgetForm
          businessId={business}
          assistantBffPrefix={assistantBffPrefix}
        />
      ) : null}
      <AgentCreditCapForm />
    </div>
  )
}
