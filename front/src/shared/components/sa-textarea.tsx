'use client'

import * as React from 'react'

import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface SaTextareaProps extends React.ComponentProps<'textarea'> {
  label?: string
  error?: string
  hint?: string
  showCount?: boolean
}

function SaTextarea({
  className,
  label,
  error,
  hint,
  maxLength,
  showCount = false,
  value,
  defaultValue,
  onChange,
  id: externalId,
  ...props
}: SaTextareaProps) {
  const autoId = React.useId()
  const inputId = externalId ?? autoId
  const hintId = hint ? `${inputId}-hint` : undefined
  const errorId = error ? `${inputId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  const isControlled = typeof value === 'string'
  const [uncontrolledCount, setUncontrolledCount] = React.useState(() => {
    return typeof defaultValue === 'string' ? defaultValue.length : 0
  })
  const charCount = isControlled ? value.length : uncontrolledCount

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!isControlled) setUncontrolledCount(e.target.value.length)
    onChange?.(e)
  }

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
      <Textarea
        id={inputId}
        className={cn(
          'bg-sa-surface-card border-sa-border-default text-sa-text-primary placeholder:text-sa-text-muted focus-visible:border-sa-border-focus focus-visible:ring-sa-border-focus/20',
          error &&
            'border-sa-state-error focus-visible:border-sa-state-error focus-visible:ring-sa-state-error/20',
          className
        )}
        maxLength={maxLength}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1">
          {hint && !error && (
            <p id={hintId} className="text-sa-text-muted text-xs">
              {hint}
            </p>
          )}
          {error && (
            <p
              id={errorId}
              className="text-sa-state-error text-xs"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
        {showCount && maxLength && (
          <p className="text-sa-text-muted shrink-0 text-xs">
            {charCount}/{maxLength}
          </p>
        )}
      </div>
    </div>
  )
}

export { SaTextarea }
