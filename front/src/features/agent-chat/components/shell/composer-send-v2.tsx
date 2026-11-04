'use client'

import { ArrowUp, Stop } from '@phosphor-icons/react'
import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { AgentMetalRingV2 } from '../design-system/live-effects'
import styles from './composer-send-v2.module.css'

interface ComposerSendV2Props {
  label: string
  enabled: boolean
  variant: 'hero' | 'chat'
  hasText?: boolean
  attachmentOnly?: boolean
  stopping?: boolean
  theme?: 'dark' | 'light'
  onClick: () => void
}

/** Source: Hero/Composer + live/Turno.IconoEnviar, 0b3f6c0. */
export function ComposerSendV2({
  label,
  enabled,
  variant,
  hasText = false,
  attachmentOnly = false,
  stopping = false,
  theme = 'dark',
  onClick,
}: ComposerSendV2Props) {
  return (
    <AgentMetalRingV2
      theme={theme}
      strength={variant === 'hero' && !hasText ? 0.28 : 1}
      className={styles.ring}
    >
      <button
        type="button"
        data-agent-ui="v2"
        data-variant={variant}
        data-has-text={hasText || undefined}
        data-stopping={stopping || undefined}
        data-client-trace-operation={
          attachmentOnly ? 'library' : 'agent_chat_turn'
        }
        data-client-trace-component={attachmentOnly ? 'library' : 'agent_chat'}
        data-client-trace-state={
          attachmentOnly || !enabled ? 'blocked' : 'active'
        }
        data-client-trace-reason={
          attachmentOnly ? 'library_requires_prompt' : undefined
        }
        className={styles.button}
        aria-label={label}
        title={label}
        disabled={!enabled}
        onClick={onClick}
      >
        {variant === 'hero' ? (
          <ArrowUp size={20} weight="bold" aria-hidden focusable="false" />
        ) : (
          <SendIcon stopping={stopping} />
        )}
      </button>
    </AgentMetalRingV2>
  )
}

function SendIcon({ stopping }: { stopping: boolean }) {
  return (
    <span aria-hidden className={styles.icon}>
      <MotionConfig reducedMotion="user">
        <AnimatePresence initial={false}>
          <motion.span
            key={stopping ? 'stop' : 'send'}
            className={styles.glyph}
            initial={{ opacity: 0, scale: 0.5, rotate: stopping ? -90 : 90 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.14 } }}
            transition={{ type: 'spring', visualDuration: 0.28, bounce: 0.2 }}
          >
            {stopping ? (
              <Stop size={15} weight="fill" focusable="false" />
            ) : (
              <ArrowUp size={18} weight="bold" focusable="false" />
            )}
          </motion.span>
        </AnimatePresence>
      </MotionConfig>
    </span>
  )
}
