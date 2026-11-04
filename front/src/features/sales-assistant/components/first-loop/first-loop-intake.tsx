'use client'

import { useTranslations } from 'next-intl'
import { SaButton } from '@/shared/components/sa-button'
import type { FirstLoopState } from '../../types/first-loop.schemas'
import { FirstLoopComposer } from './first-loop-composer'

interface Props {
  state: FirstLoopState
  busy: boolean
  disabled: boolean
  onSend: (text: string) => Promise<boolean>
  onConfirm: () => Promise<boolean>
}

function Transcript({ state, busy }: Pick<Props, 'state' | 'busy'>) {
  const t = useTranslations('metaAssistant.firstLoop')
  if (!state.messages.length) return null
  return (
    <div
      role="log"
      aria-label={t('conversation')}
      aria-live="polite"
      aria-busy={busy}
      data-mask=""
      data-sentry-mask=""
      className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto"
    >
      {state.messages.map(message => (
        <article
          key={message.id}
          className="border-sa-border-default bg-sa-surface-card flex flex-col gap-1 rounded-xl border p-4"
        >
          <p className="text-sa-text-tertiary text-xs">
            {t(message.role === 'user' ? 'you' : 'ale')}
          </p>
          <p className="text-sa-text-primary text-sm break-words whitespace-pre-wrap">
            {message.text}
          </p>
        </article>
      ))}
    </div>
  )
}

function BriefSummary({ state }: Pick<Props, 'state'>) {
  const t = useTranslations('metaAssistant.firstLoop')
  const brief = state.brief
  if (!brief) return null
  const fields = [
    ['goalLabel', brief.goal],
    ['offeringLabel', brief.offering],
    ['marketLabel', brief.market],
  ] as const
  return (
    <section
      aria-label={t('briefTitle')}
      className="border-sa-border-default flex flex-col gap-3 rounded-xl border p-4"
      data-mask=""
      data-sentry-mask=""
    >
      <h3 className="text-sa-text-primary font-medium">
        {t('briefTitle')} · {t('revision', { value: state.brief_revision })}
      </h3>
      <dl className="flex flex-col gap-3">
        {fields.map(([label, value]) =>
          value ? (
            <div key={label}>
              <dt className="text-sa-text-tertiary text-xs">{t(label)}</dt>
              <dd className="text-sa-text-primary text-sm whitespace-pre-wrap">
                {value}
              </dd>
            </div>
          ) : null
        )}
      </dl>
      {brief.constraints.length > 0 && (
        <div>
          <p className="text-sa-text-tertiary text-xs">
            {t('constraintsLabel')}
          </p>
          <ul className="text-sa-text-secondary list-disc pl-5 text-sm">
            {brief.constraints.map((constraint, index) => (
              <li key={index}>{constraint}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function FirstLoopIntake({
  state,
  busy,
  disabled,
  onSend,
  onConfirm,
}: Props) {
  const t = useTranslations('metaAssistant.firstLoop')
  const intake = !state.active_work_id
  const confirmable =
    intake &&
    state.phase === 'confirm_brief' &&
    !!state.brief &&
    state.missing_fields.length === 0
  return (
    <>
      <Transcript state={state} busy={busy} />
      {intake && <BriefSummary state={state} />}
      {confirmable && (
        <div>
          <SaButton
            variant="primary"
            onClick={() => void onConfirm()}
            disabled={busy || disabled}
            aria-busy={busy}
          >
            {busy ? t('actions.confirming') : t('actions.confirm')}
          </SaButton>
        </div>
      )}
      {intake && (
        <FirstLoopComposer
          mode="brief"
          busy={busy}
          disabled={disabled}
          onSend={onSend}
        />
      )}
    </>
  )
}
