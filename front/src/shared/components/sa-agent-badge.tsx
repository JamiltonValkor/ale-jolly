'use client'

import type { MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import { UsersThree } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { SaBadge, saBadgeVariants } from './sa-badge'

interface Props {
  /** Abre la traza de lo que hizo el equipo; sin él el sello es solo informativo. */
  onOpenTrace?: () => void
  className?: string
}

/**
 * Sello del equipo autónomo (MAN-016, D20): ícono + texto, nunca solo color.
 * Solo se pinta para ítems con `origin === 'agent'` (lo decide quien lo usa
 * con `resolveAuthorship`). Las tarjetas enteras son clicables, así que el
 * click no se propaga.
 */
export function SaAgentBadge({ onOpenTrace, className }: Props) {
  const t = useTranslations('autonomousTeam.badge')
  const content = (
    <>
      <UsersThree weight="bold" aria-hidden="true" />
      {t('label')}
    </>
  )
  if (!onOpenTrace)
    return (
      <SaBadge
        variant="agent"
        size="sm"
        className={className}
        aria-label={t('ariaStatic')}
      >
        {content}
      </SaBadge>
    )
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onOpenTrace()
  }
  return (
    <button
      type="button"
      onClick={open}
      aria-label={t('aria')}
      className={cn(
        saBadgeVariants({ variant: 'agent', size: 'sm' }),
        'focus-visible:ring-sa-agent cursor-pointer hover:brightness-125 focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
    >
      {content}
    </button>
  )
}
