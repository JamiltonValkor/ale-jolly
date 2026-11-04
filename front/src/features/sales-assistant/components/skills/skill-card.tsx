'use client'

import { useTranslations } from 'next-intl'
import { PuzzlePiece } from '@phosphor-icons/react'
import { SaBadge } from '@/shared/components/sa-badge'
import { SaButton } from '@/shared/components/sa-button'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'
import type { CatalogItem } from '../../types'

export type SkillCardAction = 'install' | 'uninstall' | null

interface Props {
  item: CatalogItem
  action: SkillCardAction
  isBusy: boolean
  onAction: (item: CatalogItem, action: 'install' | 'uninstall') => void
  className?: string
}

/** Una habilidad del catálogo (patrón de connection-card, sin importarlo). */
export function SkillCard({
  item,
  action,
  isBusy,
  onAction,
  className,
}: Props) {
  const t = useTranslations('salesAssistant.skills')
  return (
    <SaCard
      variant="filled"
      className={cn('flex-row items-start gap-3 p-4', className)}
    >
      <PuzzlePiece
        aria-hidden="true"
        className="text-sa-purple-400 mt-0.5 size-5 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sa-text-primary text-sm font-semibold break-words">
            {item.name}
          </h3>
          <SaBadge size="sm" variant="info">
            {t(`source.${item.source}`)}
          </SaBadge>
        </div>
        <p className="text-sa-text-tertiary text-xs">
          {t('version', { version: item.version })}
        </p>
        {item.summary ? (
          <p className="text-sa-text-secondary text-sm">{item.summary}</p>
        ) : null}
      </div>
      {action ? (
        <SaButton
          size="sm"
          variant={action === 'install' ? 'accent' : 'outline'}
          disabled={isBusy}
          onClick={() => onAction(item, action)}
        >
          {t(action)}
        </SaButton>
      ) : (
        <SaBadge size="sm" variant="success">
          {t('installed')}
        </SaBadge>
      )}
    </SaCard>
  )
}
