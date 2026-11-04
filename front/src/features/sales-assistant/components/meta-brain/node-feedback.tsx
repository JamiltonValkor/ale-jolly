'use client'

import { useId, useState } from 'react'
import { Check, PencilSimple, Prohibit } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { FeedbackInput, FeedbackState, FeedbackStatus } from './types'
import styles from './meta-brain.module.css'

interface Props {
  nodeId: string
  state: FeedbackState
  onFeedback: (input: FeedbackInput) => void
  className?: string
}

function StatusLine({ status }: { status: FeedbackStatus }) {
  const t = useTranslations('metaBrain.feedback')
  if (status === 'idle') return null
  if (status === 'error')
    return (
      <p role="alert" className={cn(styles.status, styles.statusBad)}>
        {t('error')}
      </p>
    )
  return (
    <p
      role="status"
      className={cn(
        styles.status,
        (status === 'sent' || status === 'queued') && styles.statusOk
      )}
    >
      {t(status)}
    </p>
  )
}

/** Las acciones del dueño sobre una idea: Confirmar, Corregir, Ya no aplica. */
export function NodeFeedback({ nodeId, state, onFeedback, className }: Props) {
  const t = useTranslations('metaBrain.feedback')
  const fieldId = useId()
  const [correcting, setCorrecting] = useState(false)
  const [text, setText] = useState('')
  const status =
    state.nodeId === nodeId ? state.status : (state.settled?.[nodeId] ?? 'idle')
  const pending = status === 'pending'
  const done =
    status === 'sent' || status === 'queued' || status === 'unavailable'
  if (done)
    return (
      <div className={cn(styles.feedback, className)}>
        <StatusLine status={status} />
      </div>
    )
  return (
    <div className={cn(styles.feedback, className)}>
      {correcting ? (
        <>
          <label htmlFor={fieldId} className={styles.srOnly}>
            {t('fieldLabel')}
          </label>
          <textarea
            id={fieldId}
            className={styles.textarea}
            maxLength={1000}
            placeholder={t('placeholder')}
            value={text}
            onChange={event => setText(event.target.value)}
          />
          <div className={styles.feedbackRow}>
            <button
              type="button"
              className={cn(styles.ghostButton)}
              onClick={() => setCorrecting(false)}
              style={{ marginLeft: 'auto' }}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending || !text.trim()}
              onClick={() =>
                onFeedback({ nodeId, action: 'correct', text: text.trim() })
              }
            >
              {t('send')}
            </button>
          </div>
        </>
      ) : (
        <div className={styles.feedbackRow}>
          <span className={styles.feedbackQuestion}>{t('question')}</span>
          <button
            type="button"
            className={styles.outlineButton}
            disabled={pending}
            onClick={() => onFeedback({ nodeId, action: 'no_longer_applies' })}
          >
            <Prohibit size={14} weight="light" aria-hidden="true" />
            {t('noLongerApplies')}
          </button>
          <button
            type="button"
            className={styles.outlineButton}
            disabled={pending}
            onClick={() => setCorrecting(true)}
          >
            <PencilSimple size={14} weight="light" aria-hidden="true" />
            {t('correct')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={pending}
            onClick={() => onFeedback({ nodeId, action: 'confirm' })}
          >
            <Check size={14} weight="bold" aria-hidden="true" />
            {t('confirm')}
          </button>
        </div>
      )}
      <StatusLine status={status} />
    </div>
  )
}
