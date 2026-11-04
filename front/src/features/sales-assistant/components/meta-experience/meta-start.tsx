'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useBusinessStore } from '@/store/use-business-store'
import { useSalesAssistantActivation } from '../../hooks/use-sales-assistant-activation'
import {
  readPendingType,
  savePendingType,
  typeFromOffering,
} from '../../lib/business-type'
import { salesAssistantErrorKey } from '../../lib/error-messages'
import { useAssistantRuntime } from '../../runtime'
import type { BusinessType } from '../../types'
import { MetaStartView } from './meta-start-view'
import type { RenderCompanion } from './types'

interface Props {
  renderCompanion?: RenderCompanion
}

/**
 * Llegada conectada: misma activación en un clic que antes (clave de
 * idempotencia, salto al acceso y vuelta solos) y el tipo de negocio
 * precargado con lo que Saleads ya sabe.
 */
export function MetaStart({ renderCompanion }: Props) {
  const tErrors = useTranslations('salesAssistant')
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
  return (
    <MetaStartView
      businessName={business?.business_name ?? null}
      type={type}
      prefilled={Boolean(prefill) && !chosen}
      onChooseType={choose}
      onActivate={start}
      busy={isBusy}
      errorMessage={error ? tErrors(salesAssistantErrorKey(error)) : null}
      renderCompanion={renderCompanion}
    />
  )
}
