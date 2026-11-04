'use client'

import { useState, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { PaperPlaneRight } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { SaTextarea } from '@/shared/components/sa-textarea'
import { cn } from '@/lib/utils'

/** Límite del cuerpo `{text}` del stream (1..8000, OCF-002). */
export const CHAT_TEXT_MAX = 8000

interface Props {
  /** Falso mientras el asistente responde: se puede escribir, no enviar. */
  canSend: boolean
  busy: boolean
  onSend: (text: string) => void | Promise<boolean>
  /** Meta's durable send keeps its draft until an actual receipt; classic callers retain their behavior. */
  awaitAcceptance?: boolean
  /** Reserve room for an optional page reference without truncating the owner draft. */
  textLimit?: number
  className?: string
}

/**
 * Caja para escribirle al asistente. Enter envía, Shift + Enter agrega una
 * línea. El campo nunca se deshabilita mientras responde, para no perder el
 * foco del teclado. Va enmascarado en los replays de PostHog y Sentry.
 */
export function SalesAssistantChatComposer({
  canSend,
  busy,
  onSend,
  awaitAcceptance = false,
  textLimit = CHAT_TEXT_MAX,
  className,
}: Props) {
  const t = useTranslations('salesAssistant.chat.composer')
  const [draft, setDraft] = useState('')
  const text = draft.trim()
  const tooLong = text.length > Math.min(textLimit, CHAT_TEXT_MAX)
  const ready = canSend && text.length > 0 && !tooLong

  async function submit() {
    if (!ready) return
    const outcome = onSend(text)
    if (!awaitAcceptance) {
      setDraft('')
      return
    }
    try {
      if ((await outcome) !== false)
        setDraft(current => (current.trim() === text ? '' : current))
    } catch {
      /* Keep the draft when acceptance could not be confirmed. */
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <form
      aria-label={t('label')}
      data-mask=""
      data-sentry-mask=""
      className={cn('flex flex-col gap-3', className)}
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
    >
      <SaTextarea
        label={t('label')}
        value={draft}
        rows={3}
        autoComplete="off"
        hint={t('hint')}
        error={tooLong ? t('tooLong') : undefined}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex justify-end">
        <SaButton
          type="submit"
          variant="primary"
          disabled={!ready}
          rightIcon={PaperPlaneRight}
        >
          {busy ? t('sending') : t('send')}
        </SaButton>
      </div>
    </form>
  )
}
