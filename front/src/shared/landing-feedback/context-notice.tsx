'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import type { LandingFeedbackReference } from './handoff'

/** Human page reference only; it grants no permission and never submits a message. */
export function LandingFeedbackNotice({
  reference,
  businessMatches,
}: {
  reference: LandingFeedbackReference
  businessMatches: boolean
}) {
  const t = useTranslations('metaAssistant.landingFeedback')
  const locale = useLocale()
  return (
    <div
      role="status"
      className="border-sa-border-default bg-sa-surface-elevated space-y-2 rounded-xl border p-3"
    >
      <p className="text-sa-text-secondary text-sm">
        {t('context', { name: reference.name, n: reference.n })}
      </p>
      {!businessMatches && (
        <p className="text-sa-state-warning text-sm">{t('wrongBusiness')}</p>
      )}
      <Link
        href={`/${locale}/dashboard/meta-assistant?tab=chat`}
        className="text-sa-text-link focus-visible:ring-sa-border-focus rounded text-sm hover:underline focus-visible:ring-2"
      >
        {t('clear')}
      </Link>
    </div>
  )
}
