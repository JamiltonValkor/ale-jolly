'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { PaperPlaneRight } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { SaTextarea } from '@/shared/components/sa-textarea'

interface Props {
  mode: 'brief' | 'feedback'
  busy: boolean
  disabled?: boolean
  onSend: (text: string) => Promise<boolean>
}

/** Retains an unacknowledged draft; the parent reconciles the same durable attempt. */
function useMessageDraft({ busy, disabled, onSend }: Omit<Props, 'mode'>) {
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const text = draft.trim()
  const ready =
    !disabled && !busy && !pending && text.length > 0 && text.length <= 8000
  async function submit() {
    if (!ready || lock.current) return
    lock.current = true
    setPending(true)
    try {
      if (await onSend(text))
        setDraft(current => (current.trim() === text ? '' : current))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return
    event.preventDefault()
    void submit()
  }
  return { draft, pending, ready, setDraft, submit, onKeyDown }
}

export function FirstLoopComposer({ mode, busy, disabled, onSend }: Props) {
  const t = useTranslations('metaAssistant.firstLoop')
  const { draft, pending, ready, setDraft, submit, onKeyDown } =
    useMessageDraft({ busy, disabled, onSend })
  return (
    <form
      className="flex flex-col gap-3"
      data-mask=""
      data-sentry-mask=""
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
    >
      <SaTextarea
        label={t(
          mode === 'brief' ? 'composer.label' : 'composer.feedbackLabel'
        )}
        hint={t(mode === 'brief' ? 'composer.hint' : 'composer.feedbackHint')}
        value={draft}
        rows={3}
        maxLength={8000}
        autoComplete="off"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex justify-end">
        <SaButton
          type="submit"
          variant="primary"
          rightIcon={PaperPlaneRight}
          disabled={!ready}
          aria-busy={pending || busy}
        >
          {pending || busy
            ? t('composer.sending')
            : t(mode === 'brief' ? 'composer.send' : 'composer.feedbackSend')}
        </SaButton>
      </div>
    </form>
  )
}
