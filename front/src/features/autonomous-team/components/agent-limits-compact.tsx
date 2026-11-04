'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useReconciledBusinessId } from '@/hooks/queries'
import { SaConfirmModal } from '@/shared/components/sa-confirm-modal'
import {
  useAgentBudget,
  useAgentCreditCap,
  useBudgetCurrency,
} from '../hooks/use-autonomous-team-queries'
import type { AssistantBffPrefix } from '../sdk/autonomous-team-client'
import type { AgentBudget, AgentCreditCap } from '../types'
import { Notice } from './limits-block'
import {
  BudgetCardView,
  CreditsCardView,
  type CompactCardState,
} from './limits-compact-views'
import { useBudgetEditor, type BudgetFeedback } from './use-budget-editor'
import { useCapEditor } from './use-cap-editor'

const COT = 'America/Bogota'

interface Props {
  /** Negocio activo; por defecto el seleccionado en la web. */
  businessId?: string | null
  assistantBffPrefix?: AssistantBffPrefix
}

function readState(query: {
  isPending: boolean
  isError: boolean
  data?: { available: boolean }
}): CompactCardState {
  if (query.isPending) return 'loading'
  if (query.isError) return 'error'
  return query.data?.available ? 'ready' : 'unavailable'
}

/**
 * «Límites» de Meta Assistant: la pauta y los créditos en dos tarjetas
 * cortas (cifra, una línea y guardar). Mismos datos y mismo guardado que
 * `AgentLimitsPanel`; lo que explica vive en el «?» de la pestaña.
 */
export function AgentLimitsCompact({ businessId, assistantBffPrefix }: Props) {
  const selected = useReconciledBusinessId()
  const business = businessId === undefined ? selected : businessId
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {business ? (
        <BudgetCompact
          businessId={business}
          assistantBffPrefix={assistantBffPrefix}
        />
      ) : null}
      <CreditsCompact />
    </div>
  )
}

function BudgetCompact({
  businessId,
  assistantBffPrefix,
}: {
  businessId: string
  assistantBffPrefix?: AssistantBffPrefix
}) {
  const budget = useAgentBudget(businessId, assistantBffPrefix)
  const state = readState(budget)
  if (state !== 'ready' || !budget.data?.available)
    return <BudgetCardView state={state} amount={null} month="" />
  return (
    <BudgetCompactEditor
      businessId={businessId}
      budget={budget.data.data}
      assistantBffPrefix={assistantBffPrefix}
    />
  )
}

function BudgetFeedbackNotice({ feedback }: { feedback: BudgetFeedback }) {
  const t = useTranslations('autonomousTeam.limits')
  if (feedback === 'saved') return <Notice kind="success" text={t('saved')} />
  if (feedback === 'conflict')
    return <Notice kind="warning" text={t('budget.conflict')} />
  if (feedback === 'saveError')
    return <Notice kind="error" text={t('saveError')} />
  return null
}

function BudgetCompactEditor({
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
  const code = currency.data ?? null
  const month = format.dateTime(new Date(`${budget.period_start}T12:00:00Z`), {
    month: 'long',
    timeZone: COT,
  })
  return (
    <BudgetCardView
      state="ready"
      amount={
        budget.amount
          ? editor.money(budget.amount.amount, budget.amount.currency)
          : null
      }
      month={month}
      connect={!currency.isPending && !currency.isError && !code}
      form={
        code
          ? {
              label: t('compact.budget.label', { currency: code }),
              placeholder: format.number(1500000),
              value: editor.typed,
              onChange: editor.setTyped,
              error: editor.invalid ? t('budget.invalid') : undefined,
              pending: editor.pending,
              onSubmit: editor.save,
              inputMode: 'decimal',
            }
          : undefined
      }
      notice={
        <>
          {currency.isError ? <Notice kind="error" text={t('error')} /> : null}
          <BudgetFeedbackNotice feedback={editor.feedback} />
          {code ? (
            <SaConfirmModal
              open={editor.confirming !== null}
              onOpenChange={open => {
                if (!open) editor.cancel()
              }}
              title={t('budget.confirmTitle')}
              description={t('budget.confirmDescription', {
                amount: editor.money(editor.confirming ?? 0, code),
              })}
              confirmLabel={t('budget.confirm')}
              cancelLabel={t('cancel')}
              onConfirm={() =>
                editor.confirming !== null &&
                editor.confirm(code, editor.confirming)
              }
              onCancel={editor.cancel}
            />
          ) : null}
        </>
      }
    />
  )
}

function CreditsCompact() {
  const cap = useAgentCreditCap()
  const state = readState(cap)
  if (state !== 'ready' || !cap.data?.available)
    return <CreditsCardView state={state} cap={null} used={0} resets="" />
  return <CreditsCompactEditor view={cap.data.data} />
}

function CreditsCompactEditor({ view }: { view: AgentCreditCap }) {
  const t = useTranslations('autonomousTeam.limits')
  const format = useFormatter()
  const editor = useCapEditor()
  return (
    <CreditsCardView
      state="ready"
      cap={view.cap}
      used={view.used_this_period}
      resets={format.dateTime(new Date(view.period_end), {
        day: 'numeric',
        month: 'short',
        timeZone: COT,
      })}
      form={{
        label: t('compact.credits.label'),
        placeholder: format.number(200),
        value: editor.typed,
        onChange: editor.setTyped,
        error: editor.invalid ? t('credits.invalid') : undefined,
        pending: editor.pending,
        onSubmit: editor.save,
        inputMode: 'numeric',
      }}
      notice={
        <>
          {editor.feedback === 'saved' ? (
            <Notice kind="success" text={t('saved')} />
          ) : editor.feedback === 'saveError' ? (
            <Notice kind="error" text={t('saveError')} />
          ) : null}
          <SaConfirmModal
            open={editor.confirming !== null}
            onOpenChange={open => {
              if (!open) editor.cancel()
            }}
            title={t('credits.confirmTitle')}
            description={t('credits.confirmDescription', {
              cap: format.number(editor.confirming ?? 0),
            })}
            confirmLabel={t('credits.confirm')}
            cancelLabel={t('cancel')}
            onConfirm={() =>
              editor.confirming !== null && editor.confirm(editor.confirming)
            }
            onCancel={editor.cancel}
          />
        </>
      }
    />
  )
}
