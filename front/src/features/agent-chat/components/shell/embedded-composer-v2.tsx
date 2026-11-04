'use client'

import { useState, type ReactNode, type RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Info } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { agentV2FontClassName } from '../../lib/fonts-v2'
import { ComposerSendV2 } from './composer-send-v2'
import { ComposerSurfaceV2 } from './composer-surface-v2'
import { ComposerVoiceTriggerV2, ComposerVoiceV2 } from './composer-voice-v2'
import '../theme/agent-theme.css'
import '../theme/agent-design-system.css'
import frame from './real-composer-v2.module.css'
import styles from './embedded-composer-v2.module.css'

export interface EmbeddedComposerV2Props {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  canSubmit: boolean
  label: string
  placeholder: string
  /** Aviso bajo el compositor, como en el chat del modo agente. */
  disclaimer?: string
  maxLength?: number
  /** Con `false`, el límite no corta lo que se escribe: lo avisa el anfitrión. */
  enforceMaxLength?: boolean
  inputRef?: RefObject<HTMLTextAreaElement | null>
  /** Controles del anfitrión a la izquierda (p. ej. «leer en voz alta»). */
  leading?: ReactNode
  className?: string
}

/**
 * El compositor del chat del modo agente (carcasa, haz de luz al enfocar,
 * dictado por voz y botón de enviar animado) para otras superficies que
 * llevan su propia conversación: sin sesión del agente ni biblioteca.
 */
export function EmbeddedComposerV2({
  value,
  onValueChange,
  onSubmit,
  canSubmit,
  label,
  placeholder,
  disclaimer,
  maxLength = 4000,
  enforceMaxLength = true,
  inputRef,
  leading,
  className,
}: EmbeddedComposerV2Props) {
  const t = useTranslations('agentChat.composer')
  const [dictating, setDictating] = useState(false)
  const confirmDictation = (text: string) => {
    const next = [value.trim(), text.trim()].filter(Boolean).join(' ')
    if (next.length > maxLength) return false
    onValueChange(next)
    setDictating(false)
    inputRef?.current?.focus()
    return true
  }
  return (
    <div
      data-agent-shell=""
      data-agent-design="v2"
      data-theme="dark"
      className={cn(agentV2FontClassName, styles.root, className)}
    >
      <div className={frame.frame}>
        <ComposerSurfaceV2
          variant="chat"
          label={label}
          placeholder={placeholder}
          value={value}
          maxLength={enforceMaxLength ? maxLength : undefined}
          inputRef={inputRef}
          onValueChange={onValueChange}
          onSubmit={onSubmit}
          canSubmit={canSubmit}
          theme="dark"
          alternateContent={
            dictating ? (
              <ComposerVoiceV2
                onConfirm={confirmDictation}
                onCancel={() => setDictating(false)}
              />
            ) : undefined
          }
          controls={
            <>
              {leading}
              <span className="min-w-0 flex-1" />
              <ComposerVoiceTriggerV2
                variant="chat"
                enabled={process.env.NEXT_PUBLIC_AGENT_CHAT_VOICE === 'true'}
                busy={false}
                onOpen={() => setDictating(true)}
              />
              <ComposerSendV2
                variant="chat"
                theme="dark"
                hasText={value.trim().length > 0}
                enabled={canSubmit}
                label={t('send')}
                onClick={onSubmit}
              />
            </>
          }
        />
      </div>
      {disclaimer ? (
        <p className={frame.disclaimer}>
          <Info size={11} weight="regular" aria-hidden />
          <span>{disclaimer}</span>
        </p>
      ) : null}
    </div>
  )
}
