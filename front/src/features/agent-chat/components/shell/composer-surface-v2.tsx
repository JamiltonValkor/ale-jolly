'use client'

import {
  useState,
  type ClipboardEventHandler,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { AgentBorderBeamV2 } from '../design-system/live-effects'
import styles from './composer-surface-v2.module.css'

interface ComposerSurfaceV2Props {
  variant: 'hero' | 'chat'
  label: string
  placeholder: string
  value: string
  maxLength?: number
  inputRef?: Ref<HTMLTextAreaElement>
  onValueChange: (value: string) => void
  onSubmit: () => void
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>
  canSubmit: boolean
  theme?: 'dark' | 'light'
  notice?: ReactNode
  controls: ReactNode
  alternateContent?: ReactNode
}

/** Exact presentation wrappers; the consumer owns acceptance and draft clearing. */
export function ComposerSurfaceV2({
  theme = 'dark',
  notice,
  controls,
  alternateContent,
  ...input
}: ComposerSurfaceV2Props) {
  const [focused, setFocused] = useState(false)
  return (
    <AgentBorderBeamV2 active={focused} theme={theme} className={styles.beam}>
      <div
        data-agent-ui="v2"
        data-composer-variant={input.variant}
        className={styles.surface}
      >
        {notice}
        <div className={styles.content}>
          {alternateContent ?? (
            <>
              <ComposerInput {...input} onFocusChange={setFocused} />
              <div className={styles.controls}>{controls}</div>
            </>
          )}
        </div>
      </div>
    </AgentBorderBeamV2>
  )
}

type InputProps = Omit<
  ComposerSurfaceV2Props,
  'controls' | 'notice' | 'theme' | 'alternateContent'
> & {
  onFocusChange: (focused: boolean) => void
}

function ComposerInput({
  label,
  placeholder,
  value,
  maxLength,
  inputRef,
  onValueChange,
  onSubmit,
  onPaste,
  canSubmit,
  onFocusChange,
}: InputProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return
    event.preventDefault()
    if (canSubmit) onSubmit()
  }
  return (
    <textarea
      ref={inputRef}
      data-agent-composer-input
      className={styles.input}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      maxLength={maxLength}
      spellCheck={false}
      rows={2}
      onChange={event => onValueChange(event.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
    />
  )
}
