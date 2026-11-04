'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useBusinessStore } from '@/store/use-business-store'
import { SaButton } from '@/shared/components/sa-button'
import { SaCard } from '@/shared/components/sa-card'
import { SaConfirmModal } from '@/shared/components/sa-confirm-modal'
import { useUpdateBusinessProfile } from '../../hooks/use-orqa-mutations'
import { useBusinessProfile } from '../../hooks/use-orqa-queries'
import type { BusinessType } from '../../types'
import { BusinessTypeChoice } from '../business-type-choice'

/**
 * «Tipo de negocio» del negocio seleccionado (MLF-001): elige las skills del
 * equipo. Cambiarlo pide confirmación porque cambian las skills. Un error del
 * servicio se trata como «elige» con reintento: nunca bloquea el panel.
 */
export function BusinessTypeCard() {
  const t = useTranslations('salesAssistant.businessType')
  const business = useBusinessStore(state => state.selectedBusiness)
  const businessId = business?.business_id ?? null
  const profile = useBusinessProfile(businessId)
  const update = useUpdateBusinessProfile(businessId ?? '')
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<BusinessType | null>(null)
  if (!businessId) return null

  const current = profile.data?.needs_choice
    ? null
    : (profile.data?.business_type ?? null)
  const choosing = editing || current === null
  const save = (type: BusinessType) => {
    update.mutate(type, { onSuccess: () => setEditing(false) })
  }
  return (
    <SaCard variant="filled" className="gap-3 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sa-text-primary text-base font-semibold">
            {t('title')}
          </h3>
          <p className="text-sa-text-secondary text-sm">
            {current
              ? t('current', { type: t(`options.${current}.title`) })
              : t('choose')}
          </p>
        </div>
        {current && !editing ? (
          <SaButton
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
          >
            {t('change')}
          </SaButton>
        ) : null}
      </div>
      {profile.isError ? (
        <div className="flex items-center gap-3">
          <p role="status" className="text-sa-text-tertiary text-xs">
            {t('unavailable')}
          </p>
          <SaButton
            variant="outline"
            size="sm"
            onClick={() => void profile.refetch()}
          >
            {t('retry')}
          </SaButton>
        </div>
      ) : null}
      {choosing && !profile.isPending ? (
        <BusinessTypeChoice
          value={editing ? current : null}
          disabled={update.isPending}
          onChange={type => (current ? setPending(type) : save(type))}
        />
      ) : null}
      {update.isError ? (
        <p role="alert" className="text-sa-text-secondary text-sm">
          {t('error')}
        </p>
      ) : null}
      <SaConfirmModal
        open={pending !== null}
        onOpenChange={open => {
          if (!open) setPending(null)
        }}
        title={t('confirm.title')}
        description={t('confirm.description', {
          type: pending ? t(`options.${pending}.title`) : '',
        })}
        confirmLabel={t('confirm.cta')}
        cancelLabel={t('confirm.cancel')}
        isLoading={update.isPending}
        onConfirm={() => {
          if (pending) save(pending)
          setPending(null)
        }}
        onCancel={() => setPending(null)}
      />
    </SaCard>
  )
}
