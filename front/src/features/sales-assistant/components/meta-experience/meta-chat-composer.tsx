'use client'

import { forwardRef, useId, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUp, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import styles from './meta-chat.module.css'

interface Props {
  value: string
  onChange: (value: string) => void
  onSend: (text: string) => void
  canSend: boolean
  textLimit: number
  /** Leer las respuestas en voz alta (solo si hay compañero que las diga). */
  voice?: { on: boolean; toggle: () => void }
}

/** Compositor del chat nuevo: Enter envía, Shift + Enter salta de línea. */
export const MetaChatComposer = forwardRef<HTMLTextAreaElement, Props>(
  function MetaChatComposer(
    { value, onChange, onSend, canSend, textLimit, voice },
    ref
  ) {
    const t = useTranslations('metaExperience.chat')
    const hintId = useId()
    const text = value.trim()
    const tooLong = value.length > textLimit
    const ready = canSend && text.length > 0 && !tooLong
    const send = () => {
      if (ready) onSend(text)
    }
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      )
        return
      event.preventDefault()
      send()
    }
    return (
      <div className={styles.shell}>
        <div className={styles.box}>
          <textarea
            ref={ref}
            data-meta-composer=""
            className={styles.textarea}
            value={value}
            onChange={event => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('placeholder')}
            aria-label={t('inputLabel')}
            aria-describedby={hintId}
            aria-invalid={tooLong || undefined}
            rows={1}
          />
          <div className={styles.composerRow}>
            {voice ? (
              <VoiceToggle on={voice.on} onToggle={voice.toggle} />
            ) : null}
            {/* El aviso va aquí para que el compositor quede pegado abajo; el
                atajo de teclado lo anuncia el lector de pantalla. */}
            <span
              id={hintId}
              className={styles.hintText}
              role={tooLong ? 'alert' : undefined}
            >
              {tooLong ? (
                t('tooLong')
              ) : (
                <>
                  <span className="sr-only">{t('hint')}. </span>
                  {t('disclaimer')}
                </>
              )}
            </span>
            <button
              type="button"
              className={styles.send}
              onClick={send}
              aria-label={t('send')}
              aria-disabled={!ready || undefined}
            >
              <ArrowUp size={18} weight="bold" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    )
  }
)

/** Tu asistente lee en voz alta lo que responde (solo tras un gesto de la persona). */
export function VoiceToggle({
  on,
  onToggle,
}: {
  on: boolean
  onToggle: () => void
}) {
  const t = useTranslations('metaExperience.chat')
  return (
    <button
      type="button"
      className={styles.voice}
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? t('voiceOff') : t('voiceOn')}
    >
      {on ? (
        <SpeakerHigh size={18} weight="light" aria-hidden />
      ) : (
        <SpeakerSlash size={18} weight="light" aria-hidden />
      )}
    </button>
  )
}
