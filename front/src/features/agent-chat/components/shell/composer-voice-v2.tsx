'use client'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Microphone, Pause, Play, Stop, Waveform } from '@phosphor-icons/react'
import {
  useDictationSupported,
  useSpeechDictation,
  type SpeechDictation,
} from '../../hooks/use-speech-dictation'
import { formatDictationTime } from '../../lib/speech-dictation'
import styles from './composer-voice-v2.module.css'
import composerStyles from './real-composer-v2.module.css'

interface VoiceProps {
  onConfirm: (text: string) => boolean
  onCancel: () => void
  busy?: boolean
}

/**
 * E9-07/E9-08 Composer VOICEON: dictado del navegador en español. «Escribir» y
 * «Listo» dejan lo dicho en la caja; nunca se envía solo. Sin permiso, sin
 * micrófono o sin red se dice qué hacer y no se escribe nada.
 */
export function ComposerVoiceV2({
  onConfirm,
  onCancel,
  busy = false,
}: VoiceProps) {
  const t = useTranslations('agentChat.composer.dictation')
  const dictation = useSpeechDictation()
  const [tooLong, setTooLong] = useState(false)
  const text = dictation.status === 'blocked' ? '' : dictation.text.trim()
  const handOver = () => {
    if (!text) return onCancel()
    if (!busy) setTooLong(!onConfirm(text))
  }
  const panel = useEscapeToCancel(onCancel)
  return (
    <div ref={panel} className={styles.voice}>
      <VoiceTranscript dictation={dictation} />
      <VoiceActions
        dictation={dictation}
        canConfirm={!busy && !!text}
        onWrite={handOver}
        onConfirm={handOver}
      />
      {busy ? (
        <p className={styles.error} role="status">
          {t('busy')}
        </p>
      ) : null}
      {tooLong ? (
        <p className={styles.error} role="alert">
          {t('tooLong')}
        </p>
      ) : null}
    </div>
  )
}

/** Escape dentro del panel vuelve a escribir sin tocar el borrador. */
function useEscapeToCancel(onCancel: () => void) {
  const panel = useRef<HTMLDivElement>(null)
  const cancel = useRef(onCancel)
  useEffect(() => {
    cancel.current = onCancel
  })
  useEffect(() => {
    const node = panel.current
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      cancel.current()
    }
    node?.addEventListener('keydown', onKeyDown)
    return () => node?.removeEventListener('keydown', onKeyDown)
  }, [])
  return panel
}

function VoiceTranscript({ dictation }: { dictation: SpeechDictation }) {
  const t = useTranslations('agentChat.composer.dictation')
  if (dictation.block)
    return (
      <p className={styles.transcript} role="alert">
        {t(`blocked.${dictation.block}.text`)}
      </p>
    )
  return (
    <p
      className={styles.transcript}
      role="status"
      aria-label={t('transcript')}
      data-empty={!dictation.text}
    >
      {dictation.text || t('empty')}
    </p>
  )
}

function useVoiceCopy(dictation: SpeechDictation) {
  const t = useTranslations('agentChat.composer.dictation')
  if (dictation.block)
    return {
      title: t(`blocked.${dictation.block}.title`),
      hint: t(`blocked.${dictation.block}.hint`),
    }
  if (dictation.status === 'paused')
    return { title: t('paused'), hint: t('hintPaused') }
  const time = formatDictationTime(dictation.seconds)
  return {
    title: t('listening'),
    hint: t(dictation.done ? 'hintDone' : 'hintListening', { time }),
  }
}

function VoiceActions({
  dictation,
  canConfirm,
  onWrite,
  onConfirm,
}: {
  dictation: SpeechDictation
  canConfirm: boolean
  onWrite: () => void
  onConfirm: () => void
}) {
  const t = useTranslations('agentChat.composer.dictation')
  const copy = useVoiceCopy(dictation)
  const paused = dictation.status === 'paused'
  const write = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    write.current?.focus()
  }, [])
  return (
    <div className={styles.row}>
      <span
        className={styles.mic}
        data-listening={dictation.status === 'listening'}
        aria-hidden
      >
        <Microphone size={21} weight="light" />
      </span>
      <span className={styles.status}>
        <span className={styles.title}>{copy.title}</span>
        <span className={styles.hint}>{copy.hint}</span>
      </span>
      <button
        ref={write}
        type="button"
        className={styles.write}
        onClick={onWrite}
      >
        {t('write')}
      </button>
      <button
        type="button"
        className={styles.pause}
        aria-label={t(paused ? 'resume' : 'pause')}
        title={t(paused ? 'resume' : 'pause')}
        disabled={dictation.status === 'blocked'}
        onClick={paused ? dictation.resume : dictation.pause}
      >
        {paused ? (
          <Play size={16} weight="fill" aria-hidden />
        ) : (
          <Pause size={16} weight="fill" aria-hidden />
        )}
      </button>
      <button
        type="button"
        className={styles.done}
        aria-label={t('done')}
        title={t('done')}
        disabled={!canConfirm}
        onClick={onConfirm}
      >
        <Stop size={14} weight="fill" aria-hidden />
      </button>
    </div>
  )
}

/** Voz: oculto donde el navegador no dicta (D4); deshabilitado con el flag apagado. */
export function ComposerVoiceTriggerV2({
  variant,
  enabled,
  busy,
  onOpen,
}: {
  variant: 'hero' | 'chat'
  enabled: boolean
  busy: boolean
  onOpen: () => void
}) {
  const t = useTranslations('agentChat.composer')
  const tReal = useTranslations('agentChat.real')
  const supported = useDictationSupported()
  if (enabled && !supported) return null
  const label = !enabled
    ? tReal('voiceUnavailable')
    : busy
      ? t('dictation.busy')
      : t('voice')
  return (
    <button
      type="button"
      disabled={!enabled || busy}
      aria-label={label}
      title={label}
      onClick={onOpen}
      className={composerStyles.voice}
      data-variant={variant}
    >
      <Waveform size={18} weight="light" aria-hidden />
      <span className={composerStyles.voiceLabel}>{t('voice')}</span>
    </button>
  )
}
