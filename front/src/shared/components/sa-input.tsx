'use client'

import * as React from 'react'
import type { Icon } from '@phosphor-icons/react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface SaInputProps extends React.ComponentProps<'input'> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: Icon
  rightIcon?: Icon
}

const NATIVE_PICKER_TYPES = new Set([
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

function SaInput({
  className,
  label,
  error,
  hint,
  leftIcon: LeftIcon,
  rightIcon: RightIcon,
  id: externalId,
  ...props
}: SaInputProps) {
  const autoId = React.useId()
  const inputId = externalId ?? autoId
  const hintId = hint ? `${inputId}-hint` : undefined
  const errorId = error ? `${inputId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  // Native date/time pickers paint their icon from the color scheme; on our
  // dark surfaces the light-scheme icon is invisible.
  const nativePicker = NATIVE_PICKER_TYPES.has(props.type ?? '')

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="text-sa-text-secondary text-sm font-medium"
        >
          {label}
        </label>
      )}
      <div className="relative">
        {LeftIcon && (
          <LeftIcon
            className="text-sa-text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
        )}
        <Input
          id={inputId}
          className={cn(
            'bg-sa-surface-card border-sa-border-default text-sa-text-primary placeholder:text-sa-text-muted focus-visible:border-sa-border-focus focus-visible:ring-sa-border-focus/20',
            LeftIcon && 'pl-9',
            RightIcon && 'pr-9',
            nativePicker &&
              '[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:cursor-pointer',
            error &&
              'border-sa-state-error focus-visible:border-sa-state-error focus-visible:ring-sa-state-error/20',
            className
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...props}
        />
        {RightIcon && (
          <RightIcon
            className="text-sa-text-muted pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
        )}
      </div>
      {hint && !error && (
        <p id={hintId} className="text-sa-text-muted text-xs">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sa-state-error text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export { SaInput }
