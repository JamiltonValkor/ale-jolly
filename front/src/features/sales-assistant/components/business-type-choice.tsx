'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { BUSINESS_TYPES, type BusinessType } from '../types'

interface Props {
  value: BusinessType | null
  onChange: (type: BusinessType) => void
  disabled?: boolean
}

/** Las 3 opciones del tipo de negocio, explicadas en lenguaje simple (MLF-001). */
export function BusinessTypeChoice({ value, onChange, disabled }: Props) {
  const t = useTranslations('salesAssistant.businessType')
  return (
    <div
      role="radiogroup"
      aria-label={t('label')}
      className="grid gap-2 sm:grid-cols-3"
    >
      {BUSINESS_TYPES.map(type => {
        const selected = value === type
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(type)}
            className={cn(
              'flex flex-col gap-1 rounded-[var(--sa-card-radius)] border p-3 text-left transition-colors disabled:opacity-50',
              selected
                ? 'border-sa-purple-400 bg-sa-surface-elevated'
                : 'border-sa-border-default hover:border-sa-border-strong'
            )}
          >
            <span className="text-sa-text-primary text-sm font-medium">
              {t(`options.${type}.title`)}
            </span>
            <span className="text-sa-text-secondary text-xs">
              {t(`options.${type}.description`)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
