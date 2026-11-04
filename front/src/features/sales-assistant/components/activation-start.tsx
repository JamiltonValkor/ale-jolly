'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkle } from '@phosphor-icons/react'
import { useBusinessStore } from '@/store/use-business-store'
import { SaButton } from '@/shared/components/sa-button'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'
import { useSalesAssistantActivation } from '../hooks/use-sales-assistant-activation'
import {
  readPendingType,
  savePendingType,
  typeFromOffering,
} from '../lib/business-type'
import { salesAssistantErrorKey } from '../lib/error-messages'
import type { BusinessType } from '../types'
import { BusinessTypeChoice } from './business-type-choice'
import { useAssistantRuntime } from '../runtime'

interface Props {
  className?: string
}

/**
 * Sin asistente (`status=none`): «Activar mi asistente» en un clic. El salto
 * al acceso y la vuelta al panel ocurren solos; el botón queda ocupado
 * mientras tanto para que un doble clic no inicie otra activación.
 *
 * Antes del clic, el tipo de negocio (MLF-001): precargado con lo que SaleADS
 * ya sabe; si vende productos y servicios (o no se sabe), se elige. La elección
 * se manda cuando el asistente existe. Los términos (MLF-005) dicen que comparte
 * lecciones abstractas, sin datos del negocio.
 */
export function ActivationStart({ className }: Props) {
  const t = useTranslations('salesAssistant')
  const { storageNamespace } = useAssistantRuntime()
  const { activate, isBusy, error } = useSalesAssistantActivation()
  const business = useBusinessStore(state => state.selectedBusiness)
  const businessId = business?.business_id ?? null
  const prefill = typeFromOffering(business?.offering_type)
  const [chosen, setChosen] = useState<BusinessType | null>(() =>
    businessId ? readPendingType(businessId, storageNamespace) : null
  )
  const type = chosen ?? prefill
  const choose = (value: BusinessType) => {
    setChosen(value)
    if (businessId) savePendingType(businessId, value, storageNamespace)
  }
  const start = () => {
    if (businessId && type) savePendingType(businessId, type, storageNamespace)
    activate()
  }
  const needsChoice = businessId !== null && type === null
  return (
    <SaCard variant="filled" className={cn('items-start gap-4 p-6', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sa-text-primary text-lg font-semibold">
          {t('activation.title')}
        </h2>
        <p className="text-sa-text-secondary text-sm">
          {t('activation.description')}
        </p>
      </div>
      {businessId ? (
        <div className="flex w-full flex-col gap-2">
          <p className="text-sa-text-primary text-sm font-medium">
            {t('businessType.question', {
              business: business?.business_name ?? '',
            })}
          </p>
          {prefill && !chosen ? (
            <p className="text-sa-text-tertiary text-xs">
              {t('businessType.prefilled')}
            </p>
          ) : null}
          <BusinessTypeChoice
            value={type}
            onChange={choose}
            disabled={isBusy}
          />
        </div>
      ) : null}
      <p className="text-sa-text-tertiary text-xs">{t('activation.terms')}</p>
      <SaButton
        variant="primary"
        size="lg"
        leftIcon={Sparkle}
        onClick={start}
        disabled={isBusy || needsChoice}
        aria-busy={isBusy || undefined}
      >
        {isBusy ? t('activation.ctaBusy') : t('activation.cta')}
      </SaButton>
      {error && (
        <p role="alert" className="text-sa-text-secondary text-sm">
          {t(salesAssistantErrorKey(error))}
        </p>
      )}
    </SaCard>
  )
}
