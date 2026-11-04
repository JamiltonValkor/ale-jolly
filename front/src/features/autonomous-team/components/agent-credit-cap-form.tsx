'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { SaButton } from '@/shared/components/sa-button'
import { SaConfirmModal } from '@/shared/components/sa-confirm-modal'
import { SaInput } from '@/shared/components/sa-input'
import { useAgentCreditCap } from '../hooks/use-autonomous-team-queries'
import type { AgentCreditCap } from '../types'
import { LimitsBlock, Notice } from './limits-block'
import { useCapEditor } from './use-cap-editor'

export { parseCap } from './use-cap-editor'

const COT = 'America/Bogota'

/**
 * Tope mensual de créditos del agente (D15): sin tope (`cap: null`) el equipo
 * no puede generar imágenes ni piezas; `0` = no usa créditos. El saldo general
 * sigue en Ajustes → Créditos (no se duplica).
 */
export function AgentCreditCapForm() {
  const t = useTranslations('autonomousTeam.limits')
  const cap = useAgentCreditCap()
  const state = cap.isPending
    ? 'loading'
    : cap.isError
      ? 'error'
      : cap.data.available
        ? 'ready'
        : 'unavailable'
  return (
    <LimitsBlock
      title={t('credits.title')}
      help={t('credits.help')}
      state={state}
    >
      {cap.data?.available ? <CapEditor view={cap.data.data} /> : null}
    </LimitsBlock>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sa-text-tertiary text-xs">{label}</dt>
      <dd className="text-sa-text-primary text-base font-semibold">{value}</dd>
    </div>
  )
}

function CapEditor({ view }: { view: AgentCreditCap }) {
  const t = useTranslations('autonomousTeam.limits')
  const format = useFormatter()
  const editor = useCapEditor()
  const { typed, setTyped, invalid, confirming, feedback } = editor
  const count = (value: number) => format.number(value)

  return (
    <div className="flex flex-col gap-4">
      {view.cap === null ? (
        <p className="text-sa-state-warning text-sm">{t('credits.empty')}</p>
      ) : view.cap === 0 ? (
        <p className="text-sa-text-secondary text-sm">{t('credits.zero')}</p>
      ) : null}
      <dl className="grid grid-cols-3 gap-3">
        <Stat
          label={t('credits.cap')}
          value={view.cap === null ? '—' : count(view.cap)}
        />
        <Stat label={t('credits.used')} value={count(view.used_this_period)} />
        <Stat
          label={t('credits.remaining')}
          value={view.remaining === null ? '—' : count(view.remaining)}
        />
      </dl>
      <p className="text-sa-text-tertiary text-xs">
        {t('credits.resets', {
          date: format.dateTime(new Date(view.period_end), {
            dateStyle: 'medium',
            timeZone: COT,
          }),
        })}
      </p>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={event => {
          event.preventDefault()
          editor.save()
        }}
      >
        <div className="flex-1">
          <SaInput
            inputMode="numeric"
            label={t('credits.label')}
            error={invalid ? t('credits.invalid') : undefined}
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
          {t('credits.save')}
        </SaButton>
        <SaConfirmModal
          open={confirming !== null}
          onOpenChange={open => {
            if (!open) editor.cancel()
          }}
          title={t('credits.confirmTitle')}
          description={t('credits.confirmDescription', {
            cap: count(confirming ?? 0),
          })}
          confirmLabel={t('credits.confirm')}
          cancelLabel={t('cancel')}
          onConfirm={() => confirming !== null && editor.confirm(confirming)}
          onCancel={editor.cancel}
        />
      </form>
      {feedback === 'saved' ? (
        <Notice kind="success" text={t('saved')} />
      ) : null}
      {feedback === 'saveError' ? (
        <Notice kind="error" text={t('saveError')} />
      ) : null}
      <p className="text-sa-text-tertiary text-xs">
        {t('credits.balanceNote')}
      </p>
    </div>
  )
}
