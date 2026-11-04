'use client'

import type { Route } from 'next'
import Link from 'next/link'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { SaButton } from '@/shared/components/sa-button'
import { SaConfirmModal } from '@/shared/components/sa-confirm-modal'
import { SaInput } from '@/shared/components/sa-input'
import {
  useAgentBudget,
  useBudgetCurrency,
} from '../hooks/use-autonomous-team-queries'
import type { AssistantBffPrefix } from '../sdk/autonomous-team-client'
import type { AgentBudget } from '../types'
import { LimitsBlock, Notice } from './limits-block'
import { useBudgetEditor } from './use-budget-editor'

export { parseAmount } from './use-budget-editor'

const COT = 'America/Bogota'

/**
 * Presupuesto mensual aprobado (D23): lo que el equipo autónomo reparte sin
 * pedir permiso. La moneda es la de la cuenta publicitaria (V-F5), de solo
 * lectura. Guardar manda `If-Match` con la revisión leída; un 412 relee el
 * valor y avisa sin perder lo tecleado.
 */
export function AgentBudgetForm({
  businessId,
  assistantBffPrefix,
}: {
  businessId: string
  assistantBffPrefix?: AssistantBffPrefix
}) {
  const t = useTranslations('autonomousTeam.limits')
  const budget = useAgentBudget(businessId, assistantBffPrefix)
  const state = budget.isPending
    ? 'loading'
    : budget.isError
      ? 'error'
      : budget.data.available
        ? 'ready'
        : 'unavailable'
  return (
    <LimitsBlock
      title={t('budget.title')}
      help={t('budget.help')}
      state={state}
    >
      {budget.data?.available ? (
        <BudgetEditor
          businessId={businessId}
          budget={budget.data.data}
          assistantBffPrefix={assistantBffPrefix}
        />
      ) : null}
    </LimitsBlock>
  )
}

function BudgetEditor({
  businessId,
  budget,
  assistantBffPrefix,
}: {
  businessId: string
  budget: AgentBudget
  assistantBffPrefix?: AssistantBffPrefix
}) {
  const t = useTranslations('autonomousTeam.limits')
  const format = useFormatter()
  const currency = useBudgetCurrency(businessId)
  const editor = useBudgetEditor(businessId, budget, assistantBffPrefix)
  const { typed, setTyped, invalid, confirming, feedback, money } = editor
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), {
      dateStyle: 'medium',
      timeZone: COT,
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sa-text-primary text-lg font-semibold">
          {budget.amount
            ? t('budget.current', {
                amount: money(budget.amount.amount, budget.amount.currency),
              })
            : t('budget.empty')}
        </p>
        <p className="text-sa-text-tertiary text-xs">
          {t('budget.period', {
            start: day(budget.period_start),
            end: day(budget.period_end),
          })}
        </p>
        {budget.updated_at && budget.revision !== null ? (
          <p className="text-sa-text-tertiary text-xs">
            {t('budget.updated', {
              date: format.dateTime(new Date(budget.updated_at), {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: COT,
              }),
              revision: budget.revision,
            })}
          </p>
        ) : null}
      </div>
      {currency.isPending ? null : currency.isError ? (
        <Notice kind="error" text={t('error')} />
      ) : !currency.data ? (
        <ConnectMeta
          text={t('budget.connectMeta')}
          cta={t('budget.connectMetaCta')}
        />
      ) : (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={event => {
            event.preventDefault()
            editor.save()
          }}
        >
          <div className="flex-1">
            <SaInput
              inputMode="decimal"
              label={t('budget.label')}
              hint={t('budget.currency', { currency: currency.data })}
              error={invalid ? t('budget.invalid') : undefined}
              value={typed}
              onChange={event => setTyped(event.target.value)}
            />
          </div>
          <SaButton
            type="submit"
            variant="accent"
            isLoading={editor.pending}
            disabled={editor.pending}
          >
            {t('budget.save')}
          </SaButton>
          <SaConfirmModal
            open={confirming !== null}
            onOpenChange={open => {
              if (!open) editor.cancel()
            }}
            title={t('budget.confirmTitle')}
            description={t('budget.confirmDescription', {
              amount: money(confirming ?? 0, currency.data),
            })}
            confirmLabel={t('budget.confirm')}
            cancelLabel={t('cancel')}
            onConfirm={() =>
              confirming !== null && editor.confirm(currency.data!, confirming)
            }
            onCancel={editor.cancel}
          />
        </form>
      )}
      {feedback === 'saved' ? (
        <Notice kind="success" text={t('saved')} />
      ) : null}
      {feedback === 'conflict' ? (
        <Notice kind="warning" text={t('budget.conflict')} />
      ) : null}
      {feedback === 'saveError' ? (
        <Notice kind="error" text={t('saveError')} />
      ) : null}
    </div>
  )
}

/** Sin cuenta de Meta no hay moneda ni presupuesto: el camino para conectarla. */
function ConnectMeta({ text, cta }: { text: string; cta: string }) {
  const locale = useLocale()
  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sa-text-secondary text-sm">{text}</p>
      <Link
        href={`/${locale}/dashboard/connected-accounts` as Route}
        className="border-sa-border-default text-sa-text-primary hover:border-sa-border-hover inline-flex h-9 shrink-0 items-center rounded-full border px-4 text-sm font-medium transition-colors"
      >
        {cta}
      </Link>
    </div>
  )
}
