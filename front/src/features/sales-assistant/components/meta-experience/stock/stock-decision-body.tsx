'use client'

import { useId, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { StockCause, StockDecision, StockProposal } from '../../../types'
import styles from './stock.module.css'

const LIMIT_NOTE = {
  pedido: 'pedido',
  kit: 'kit',
  apuesta: 'apuesta',
} as const

interface Props {
  proposal: StockProposal
  decision: StockDecision
  causes: readonly StockCause[]
  cause: StockCause | null
  onCause: (cause: StockCause) => void
  reason: string
  onReason: (reason: string) => void
  maxReason: number
  /** R15: reparto por variante, va antes de la causa. */
  share?: ReactNode
  /** Qué falta para poder confirmar. */
  hint?: string | null
  notice: string | null
  error: string | null
}

function CausePicker({
  causes,
  cause,
  onCause,
}: Pick<Props, 'causes' | 'cause' | 'onCause'>) {
  const t = useTranslations('metaExperience.stock')
  const name = useId()
  return (
    <fieldset className={styles.causes}>
      <legend>{t('dialog.causeLegend')}</legend>
      {causes.map(option => (
        <label key={option}>
          <input
            type="radio"
            name={name}
            checked={cause === option}
            onChange={() => onCause(option)}
          />
          {t(`causes.${option}`)}
        </label>
      ))}
    </fieldset>
  )
}

function Effects({ proposal }: { proposal: StockProposal }) {
  const t = useTranslations('metaExperience.stock')
  const note =
    proposal.tipo in LIMIT_NOTE
      ? LIMIT_NOTE[proposal.tipo as keyof typeof LIMIT_NOTE]
      : null
  return (
    <>
      <ul className={styles.effects}>
        {proposal.efectos_si.map(effect => (
          <li key={effect} className={styles.yes}>
            <i aria-hidden>✓</i>
            <span>
              <span className="sr-only">{t('dialog.yes')} </span>
              {effect}
            </span>
          </li>
        ))}
        {proposal.efectos_no.map(effect => (
          <li key={effect}>
            <i aria-hidden>–</i>
            <span>
              <span className="sr-only">{t('dialog.no')} </span>
              {effect}
            </span>
          </li>
        ))}
      </ul>
      {note ? (
        <p className={styles.limit}>{t(`dialog.notes.${note}`)}</p>
      ) : null}
    </>
  )
}

/** Efectos, causa o motivo, y el estado del intento. */
export function StockDecisionBody({
  proposal,
  decision,
  causes,
  cause,
  onCause,
  reason,
  onReason,
  maxReason,
  share,
  hint,
  notice,
  error,
}: Props) {
  const t = useTranslations('metaExperience.stock')
  return (
    <div className={styles.dialogBody}>
      {decision === 'approve' ? (
        <>
          <Effects proposal={proposal} />
          {share}
          {causes.length > 0 ? (
            <CausePicker causes={causes} cause={cause} onCause={onCause} />
          ) : null}
        </>
      ) : (
        <>
          <ul className={styles.effects}>
            <li>
              <i aria-hidden>–</i>
              <span>{t('dialog.rejectEffect')}</span>
            </li>
          </ul>
          <label className={styles.reason}>
            {t('dialog.reason')}
            <textarea
              rows={2}
              maxLength={maxReason}
              value={reason}
              onChange={event => onReason(event.target.value)}
            />
          </label>
        </>
      )}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {notice ? (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" aria-live="assertive" className={styles.dialogError}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
