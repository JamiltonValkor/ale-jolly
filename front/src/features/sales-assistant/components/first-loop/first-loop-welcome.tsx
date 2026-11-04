'use client'

import { useTranslations } from 'next-intl'
import { MagnifyingGlass } from '@phosphor-icons/react'

/** Product guidance only: never inserts a fabricated assistant turn in history. */
export function FirstLoopWelcome({ businessName }: { businessName: string }) {
  const t = useTranslations('metaAssistant.firstLoop.welcome')
  return (
    <div className="flex flex-col items-start gap-3">
      <MagnifyingGlass size={28} aria-hidden className="text-sa-text-link" />
      <h2 className="text-sa-text-primary text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-sa-text-secondary text-sm">
        {t('description', { business: businessName })}
      </p>
      <p className="text-sa-text-secondary text-sm">{t('question')}</p>
      <p className="text-sa-text-tertiary text-xs">{t('approval')}</p>
    </div>
  )
}
