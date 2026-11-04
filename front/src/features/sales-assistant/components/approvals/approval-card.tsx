'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { CurrencyCircleDollar, PuzzlePiece } from '@phosphor-icons/react'
import { SaBadge } from '@/shared/components/sa-badge'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'
import type { Approval } from '../../types'

interface Props {
  approval: Approval
  className?: string
}

const STATUS_VARIANT = {
  pending: 'warning',
  executing: 'info',
  executed: 'success',
  failed: 'error',
  rejected: 'default',
  expired: 'default',
  stale: 'default',
} as const

/**
 * Lo que se va a instalar o desinstalar: nombre, versión y resumen salen del
 * catálogo de SaleADS (nunca del texto del agente) y el vencimiento de la
 * aprobación. Todo se pinta como texto.
 */
export function ApprovalCard({ approval, className }: Props) {
  const t = useTranslations('salesAssistant.approvals')
  const format = useFormatter()
  const { item } = approval
  // Solo la rama de gasto (con código) trae `monthly_budget`/`campaign_ids`;
  // el encendido del agente tiene su propia tarjeta (AAF-003).
  const details =
    approval.details && approval.details.code_required
      ? approval.details
      : undefined
  const Icon = details ? CurrencyCircleDollar : PuzzlePiece
  return (
    <SaCard variant="filled" className={cn('gap-4 p-6', className)}>
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden="true"
          className="text-sa-purple-400 mt-1 size-6 shrink-0"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sa-text-secondary text-sm">
            {t(`kind.${approval.kind}`)}
          </p>
          <h1 className="text-sa-text-primary text-xl font-semibold break-words">
            {item.name}
          </h1>
          {details ? null : (
            <p className="text-sa-text-tertiary text-sm">
              {t('version', { version: item.version })}
            </p>
          )}
        </div>
        <SaBadge
          variant={STATUS_VARIANT[approval.status]}
          className="ml-auto shrink-0"
        >
          {t(`status.${approval.status}`)}
        </SaBadge>
      </div>
      {item.summary ? (
        <p className="text-sa-text-secondary text-sm whitespace-pre-line">
          {item.summary}
        </p>
      ) : null}
      {details ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {details.monthly_budget ? (
            <div>
              <dt className="text-sa-text-tertiary text-xs">
                {t('details.monthlyBudget')}
              </dt>
              <dd className="text-sa-text-primary font-medium">
                {format.number(details.monthly_budget.amount, {
                  style: 'currency',
                  currency: details.monthly_budget.currency,
                  maximumFractionDigits: 0,
                })}
              </dd>
            </div>
          ) : null}
          {details.campaign_ids ? (
            <div>
              <dt className="text-sa-text-tertiary text-xs">
                {t('details.campaigns')}
              </dt>
              <dd className="text-sa-text-primary font-medium">
                {t('details.campaignCount', {
                  count: details.campaign_ids.length,
                })}
              </dd>
            </div>
          ) : null}
          {details.reason ? (
            <div className="sm:col-span-2">
              <dt className="text-sa-text-tertiary text-xs">
                {t('details.reason')}
              </dt>
              <dd className="text-sa-text-primary">{details.reason}</dd>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <dd className="text-sa-text-tertiary text-xs">
              {t(`details.effect.${details.action}`)}
            </dd>
          </div>
        </dl>
      ) : null}
      <p className="text-sa-text-tertiary text-xs">
        {t('expires', {
          date: format.dateTime(new Date(approval.expires_at), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        })}
      </p>
    </SaCard>
  )
}
