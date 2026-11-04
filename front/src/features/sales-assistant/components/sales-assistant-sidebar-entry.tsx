'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ChatsCircle } from '@phosphor-icons/react'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { useSalesAssistantReadyIndicator } from '../hooks/use-sales-assistant-ready-indicator'
import { useAssistantRuntime } from '../runtime'
import styles from './sales-assistant-sidebar-entry.module.css'

interface Props {
  onNavigate?: () => void
  /**
   * Meta: la cara de tu asistente (la pone el menú; viene de otra feature).
   * `engaged` = el puntero o el foco están sobre la tarjeta.
   */
  renderAvatar?: (state: { engaged: boolean }) => ReactNode
  className?: string
}

/**
 * Entrada «Mi asistente» del sidebar. Se monta solo con la bandera
 * `sales-assistant-enabled` (lo decide app-sidebar); el indicador avisa de un
 * «listo» que el dueño todavía no vio.
 */
export function SalesAssistantSidebarEntry({
  onNavigate,
  renderAvatar,
  className,
}: Props) {
  const { dashboardPath, managedAi } = useAssistantRuntime()
  const t = useTranslations(
    managedAi ? 'metaAssistant.sidebar' : 'salesAssistant.sidebar'
  )
  const locale = useLocale()
  const pathname = usePathname()
  const showIndicator = useSalesAssistantReadyIndicator()
  const href = `/${locale}${dashboardPath}`
  // Como la tarjeta de Ale: el foco cuenta igual que el puntero.
  const [engaged, setEngaged] = useState(false)

  if (managedAi && renderAvatar)
    return (
      <SidebarMenuButton
        asChild
        size="lg"
        isActive={pathname.startsWith(href)}
        tooltip={t('label')}
        className={cn(styles.card, className)}
      >
        <Link
          href={href}
          onClick={onNavigate}
          data-engaged={engaged}
          onPointerEnter={() => setEngaged(true)}
          onPointerLeave={() => setEngaged(false)}
          onFocus={() => setEngaged(true)}
          onBlur={() => setEngaged(false)}
        >
          <span className={styles.avatar} aria-hidden="true">
            {renderAvatar({ engaged })}
            {showIndicator && (
              <span
                data-testid="meta-assistant-ready-indicator"
                className={styles.readyDot}
              />
            )}
          </span>
          <span className={styles.copy}>
            <span className={styles.title}>{t('label')}</span>
            <span className={styles.subtitle}>
              {showIndicator ? t('readySubtitle') : t('subtitle')}
            </span>
          </span>
          {showIndicator && (
            <span className="sr-only">{t('readyIndicator')}</span>
          )}
        </Link>
      </SidebarMenuButton>
    )

  return (
    <SidebarMenuButton
      asChild
      isActive={pathname.startsWith(href)}
      tooltip={t('label')}
      className={cn('active:bg-sa-neutral-600', className)}
    >
      <Link href={href} onClick={onNavigate}>
        <span className="relative inline-flex shrink-0">
          {managedAi ? (
            <span
              data-testid="meta-assistant-isotype"
              aria-hidden="true"
              className={styles.isotype}
            />
          ) : (
            <ChatsCircle aria-hidden="true" />
          )}
          {showIndicator && (
            <span
              data-testid={
                managedAi
                  ? 'meta-assistant-ready-indicator'
                  : 'sales-assistant-ready-indicator'
              }
              aria-hidden="true"
              className={cn(
                'ring-sa-surface-base absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2',
                managedAi ? styles.ready : 'bg-sa-interactive-accent'
              )}
            />
          )}
        </span>
        <span>{t('label')}</span>
        {showIndicator && (
          <span className="sr-only">{t('readyIndicator')}</span>
        )}
      </Link>
    </SidebarMenuButton>
  )
}
