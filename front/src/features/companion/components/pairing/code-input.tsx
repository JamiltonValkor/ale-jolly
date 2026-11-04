'use client'

import { Fragment, useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

import { PAIRING_CODE_LENGTH } from '../../lib/pairing-code'
import styles from './pairing.module.css'

interface Props {
  /** Código ya normalizado (mayúsculas, sin separadores). */
  value: string
  onChange: (raw: string) => void
  onSubmit: () => void
  label: string
  invalid: boolean
  describedBy?: string
  disabled?: boolean
  autoFocus?: boolean
  className?: string
}

/**
 * Campo segmentado accesible: un solo `<input>` real (pegar, autocompletar
 * y lectores de pantalla funcionan como en cualquier campo) dibujado como seis
 * casillas, en dos tríos como en la pantalla del robot.
 */
export function CodeInput({
  value,
  onChange,
  onSubmit,
  label,
  invalid,
  describedBy,
  disabled,
  autoFocus = true,
  className,
}: Props) {
  const ref = useRef<HTMLInputElement>(null)
  const active = Math.min(value.length, PAIRING_CODE_LENGTH - 1)

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])

  return (
    <div className={cn(styles.codeField, className)} data-invalid={invalid}>
      <input
        ref={ref}
        className={styles.codeInput}
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
        }}
        onSelect={event => {
          // El cursor siempre al final: se escribe y se borra desde ahí.
          const input = event.currentTarget
          const end = input.value.length
          if (input.selectionStart !== end) input.setSelectionRange(end, end)
        }}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        maxLength={16}
        disabled={disabled}
      />
      <div className={styles.codeBoxes} aria-hidden="true">
        {Array.from({ length: PAIRING_CODE_LENGTH }, (_, i) => (
          <Fragment key={i}>
            {i === 4 ? <span className={styles.codeDot} /> : null}
            <span
              className={styles.codeBox}
              data-box={i}
              data-filled={Boolean(value[i])}
              data-active={i === active && value.length < PAIRING_CODE_LENGTH}
            >
              {value[i] ?? ''}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
