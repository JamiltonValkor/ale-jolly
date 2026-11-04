'use client'

import { useTranslations } from 'next-intl'
import { CheckCircle, Circle, ClockCountdown } from '@phosphor-icons/react'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'
import {
  activationStepItems,
  activationStepPercent,
  type ActivationStepItem,
} from '../lib/panel-view'
import type { SalesAssistantStep } from '../types'
import { useAssistantRuntime } from '../runtime'

interface Props {
  step: SalesAssistantStep | null
  slow: boolean
  failed: boolean
  className?: string
}

/** Solo hay 4 pasos: el avance cae siempre en uno de estos anchos. */
const BAR_WIDTH: Record<number, string> = {
  0: 'w-0',
  25: 'w-1/4',
  50: 'w-1/2',
  75: 'w-3/4',
  100: 'w-full',
}

const STEP_ICON = {
  done: CheckCircle,
  current: ClockCountdown,
  pending: Circle,
} as const

function StepRow({ item }: { item: ActivationStepItem }) {
  const { managedAi } = useAssistantRuntime()
  const t = useTranslations('salesAssistant.status')
  const managed = useTranslations(
    managedAi ? 'metaAssistant.status' : 'salesAssistant.status'
  )
  const Icon = STEP_ICON[item.state]
  return (
    <li
      aria-current={item.state === 'current' ? 'step' : undefined}
      className={cn(
        'flex items-center gap-3 text-sm',
        item.state === 'done' && 'text-sa-text-secondary',
        item.state === 'current' && 'text-sa-text-primary font-medium',
        item.state === 'pending' && 'text-sa-text-muted'
      )}
    >
      <Icon
        aria-hidden="true"
        weight={item.state === 'pending' ? 'regular' : 'fill'}
        className={cn(
          'size-5 shrink-0',
          item.state === 'done' && 'text-sa-state-success',
          item.state === 'current' && 'text-sa-interactive-accent'
        )}
      />
      <span>
        {managedAi && item.step === 'configure_ai'
          ? managed('configureAiStep')
          : t(`steps.${item.step}`)}
      </span>
      <span className="sr-only">{t(`stepState.${item.state}`)}</span>
    </li>
  )
}

function ProgressBar({ percent }: { percent: number }) {
  const t = useTranslations('salesAssistant.status')
  return (
    <div
      role="progressbar"
      aria-label={t('progressLabel')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="bg-sa-surface-elevated h-1.5 w-full overflow-hidden rounded-full"
    >
      <div
        className={cn(
          'bg-sa-interactive-accent h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none',
          BAR_WIDTH[percent] ?? 'w-0'
        )}
      />
    </div>
  )
}

/**
 * Los 4 pasos de la activación (OCF-003) con un avance honesto: solo cuentan
 * los pasos completados. Con `slow` agrega el aviso de espera; con `failed`
 * muestra el mensaje honesto. Nunca botones de reintento ni ruedita infinita.
 */
export function ActivationProgress({ step, slow, failed, className }: Props) {
  const { managedAi } = useAssistantRuntime()
  const t = useTranslations('salesAssistant.status')
  const configure = useTranslations(
    managedAi
      ? 'metaAssistant.status.configureAi'
      : 'salesAssistant.status.configureAi'
  )
  const items = activationStepItems(step)
  const copy = step === 'configure_ai' ? 'configureAi' : 'preparing'
  return (
    <SaCard variant="filled" className={cn('gap-5 p-6', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sa-text-primary text-lg font-semibold">
          {copy === 'configureAi' ? configure('title') : t('preparing.title')}
        </h2>
        <p className="text-sa-text-secondary text-sm" aria-live="polite">
          {failed
            ? t('failed')
            : copy === 'configureAi'
              ? configure('description')
              : t('preparing.description')}
        </p>
      </div>
      <ProgressBar percent={activationStepPercent(step)} />
      <ol className="flex flex-col gap-3">
        {items.map(item => (
          <StepRow key={item.step} item={item} />
        ))}
      </ol>
      {slow && !failed && (
        <p
          aria-live="polite"
          className="border-sa-state-info-border bg-sa-state-info-bg text-sa-text-primary rounded-xl border px-4 py-3 text-sm"
        >
          {t('slow')}
        </p>
      )}
    </SaCard>
  )
}
