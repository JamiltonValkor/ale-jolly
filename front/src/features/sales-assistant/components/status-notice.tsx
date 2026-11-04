'use client'

import { useTranslations } from 'next-intl'
import { CheckCircle, PauseCircle, Trash } from '@phosphor-icons/react'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'

type NoticeKind = 'ready' | 'stopped' | 'deleting'

interface Props {
  kind: NoticeKind
  className?: string
}

const NOTICE_ICON = {
  ready: CheckCircle,
  stopped: PauseCircle,
  deleting: Trash,
} as const

/** Aviso de estado del asistente: listo, desactivado o en borrado. */
export function StatusNotice({ kind, className }: Props) {
  const t = useTranslations(`salesAssistant.status.${kind}`)
  const Icon = NOTICE_ICON[kind]
  return (
    <SaCard
      variant="filled"
      role="status"
      className={cn('flex-row items-start gap-3 p-6', className)}
    >
      <Icon
        aria-hidden="true"
        weight="fill"
        className={cn(
          'mt-0.5 size-6 shrink-0',
          kind === 'ready' ? 'text-sa-state-success' : 'text-sa-text-tertiary'
        )}
      />
      <div className="flex flex-col gap-1">
        <h2 className="text-sa-text-primary text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sa-text-secondary text-sm">{t('description')}</p>
      </div>
    </SaCard>
  )
}
