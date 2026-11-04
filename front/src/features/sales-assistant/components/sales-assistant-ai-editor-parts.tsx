'use client'

import { useId, type Ref } from 'react'
import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SaButton } from '@/shared/components/sa-button'
import { SaInput } from '@/shared/components/sa-input'
import type {
  SalesAssistantAiFailureKey,
  SalesAssistantAiResultKey,
} from '../lib/ai-form-messages'
import type { SalesAssistantProvider } from '../types'

const KEY_MAX = 4096

interface ProviderFieldProps {
  providers: SalesAssistantProvider[]
  value: string
  onChange: (value: string) => void
  disabled: boolean
}

/** Selector de proveedor: solo los de `GET /providers`, en su orden. */
export function AiProviderField({
  providers,
  value,
  onChange,
  disabled,
}: ProviderFieldProps) {
  const t = useTranslations('salesAssistant.ai.fields')
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor={id}
        className="text-sa-text-secondary text-sm font-medium"
      >
        {t('provider')}
      </Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          className="border-sa-border-default bg-sa-surface-card text-sa-text-primary h-10 w-full rounded-xl"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {providers.map(provider => (
            <SelectItem key={provider.id} value={provider.id}>
              {provider.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface KeyFieldProps {
  inputRef: Ref<HTMLInputElement>
  disabled: boolean
  error: boolean
}

/**
 * Campo de la key, no controlado: su valor solo vive en el DOM hasta que el
 * editor lo toma con `useSalesAssistantSecretInput`. Sin autocompletar, sin
 * corrector y fuera de los gestores de contraseñas.
 */
export function AiKeyField({ inputRef, disabled, error }: KeyFieldProps) {
  const t = useTranslations('salesAssistant.ai')
  return (
    <SaInput
      ref={inputRef}
      type="password"
      label={t('fields.key')}
      hint={t('fields.keyHint')}
      maxLength={KEY_MAX}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      disabled={disabled}
      error={error ? t('validation.keyRequired') : undefined}
    />
  )
}

interface StatusProps {
  pending: boolean
  feedbackKey: SalesAssistantAiResultKey | SalesAssistantAiFailureKey | null
}

/** Espera de la prueba o resultado no exitoso, siempre en lenguaje simple. */
export function AiEditorStatus({ pending, feedbackKey }: StatusProps) {
  const t = useTranslations('salesAssistant')
  if (pending)
    return (
      <p role="status" className="text-sa-text-secondary text-sm">
        {t('ai.testingHint')}
      </p>
    )
  if (!feedbackKey) return null
  return (
    <p
      role="alert"
      className="border-sa-state-error-border bg-sa-state-error-bg text-sa-state-error rounded-xl border px-3 py-2 text-sm"
    >
      {t(feedbackKey)}
    </p>
  )
}

interface ActionsProps {
  pending: boolean
  onCancel?: () => void
}

/** «Probar y guardar» (prueba antes de guardar) y Cancelar al reemplazar. */
export function AiEditorActions({ pending, onCancel }: ActionsProps) {
  const t = useTranslations('salesAssistant.ai.actions')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SaButton type="submit" variant="primary" disabled={pending}>
        {pending ? t('testing') : t('save')}
      </SaButton>
      {onCancel && (
        <SaButton
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={pending}
        >
          {t('cancel')}
        </SaButton>
      )}
    </div>
  )
}
