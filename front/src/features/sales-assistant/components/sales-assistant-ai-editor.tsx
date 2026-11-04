'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { SaInput } from '@/shared/components/sa-input'
import { useConfigureSalesAssistantAiMutation } from '../hooks/use-sales-assistant-mutations'
import { useSalesAssistantSecretInput } from '../hooks/use-sales-assistant-secret-input'
import {
  aiFailureMessageKey,
  aiResultMessageKey,
  type SalesAssistantAiFailureKey,
  type SalesAssistantAiResultKey,
} from '../lib/ai-form-messages'
import { OneShotSecret } from '../lib/one-shot-secret'
import type { SalesAssistantProvider } from '../types'
import {
  AiEditorActions,
  AiEditorStatus,
  AiKeyField,
  AiProviderField,
} from './sales-assistant-ai-editor-parts'

export interface SalesAssistantAiConfig {
  provider: string
  model: string
}

interface Props {
  /** Proveedores ofrecidos, en el orden del back. */
  providers: SalesAssistantProvider[]
  initialProvider: string | null
  initialModel: string | null
  /** Solo se llama con `result=ok`: la IA quedó probada y guardada. */
  onSaved: (config: SalesAssistantAiConfig) => void
  /** Presente al reemplazar una IA ya configurada. */
  onCancel?: () => void
  className?: string
}

type FieldError = 'model' | 'key' | null

const MODEL_MAX = 200

function pickProvider(
  providers: SalesAssistantProvider[],
  initial: string | null
): string {
  if (initial && providers.some(provider => provider.id === initial))
    return initial
  return providers[0]?.id ?? ''
}

/**
 * «Probar y guardar»: valida, saca la key del input (que queda vacío) y la
 * envía envuelta en `OneShotSecret`. El valor nunca pasa por estado de React.
 */
function useAiEditorSubmit(onSaved: Props['onSaved']) {
  const mutation = useConfigureSalesAssistantAiMutation()
  const pending = mutation.isPending
  const { inputRef, take } = useSalesAssistantSecretInput(pending)
  const [fieldError, setFieldError] = useState<FieldError>(null)

  function save(provider: string, rawModel: string) {
    if (pending) return
    const model = rawModel.trim()
    if (!model) return setFieldError('model')
    const key = take()
    if (key === null) return setFieldError('key')
    setFieldError(null)
    mutation.mutate(
      { provider, model, apiKey: new OneShotSecret(key) },
      {
        onSuccess: data => {
          if (data.result === 'ok') onSaved({ provider, model })
        },
      }
    )
  }

  let feedbackKey:
    | SalesAssistantAiResultKey
    | SalesAssistantAiFailureKey
    | null = null
  if (mutation.isError) feedbackKey = aiFailureMessageKey(mutation.error)
  else if (mutation.data && mutation.data.result !== 'ok')
    feedbackKey = aiResultMessageKey(mutation.data.result)

  return { inputRef, pending, fieldError, feedbackKey, save }
}

/**
 * Formulario editable de «Configura tu IA» (OCF-004): proveedor de la lista
 * del back, modelo en texto libre y key en un campo seguro no controlado.
 */
export function SalesAssistantAiEditor({
  providers,
  initialProvider,
  initialModel,
  onSaved,
  onCancel,
  className,
}: Props) {
  const t = useTranslations('salesAssistant.ai')
  const [provider, setProvider] = useState(() =>
    pickProvider(providers, initialProvider)
  )
  const [model, setModel] = useState(initialModel ?? '')
  const { inputRef, pending, fieldError, feedbackKey, save } =
    useAiEditorSubmit(onSaved)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    save(provider, model)
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className={cn('flex flex-col gap-4', className)}
    >
      <AiProviderField
        providers={providers}
        value={provider}
        onChange={setProvider}
        disabled={pending}
      />
      <SaInput
        label={t('fields.model')}
        hint={t('fields.modelHint')}
        value={model}
        onChange={event => setModel(event.target.value)}
        maxLength={MODEL_MAX}
        autoComplete="off"
        spellCheck={false}
        disabled={pending}
        error={
          fieldError === 'model' ? t('validation.modelRequired') : undefined
        }
      />
      <AiKeyField
        inputRef={inputRef}
        disabled={pending}
        error={fieldError === 'key'}
      />
      <AiEditorStatus pending={pending} feedbackKey={feedbackKey} />
      <AiEditorActions pending={pending} onCancel={onCancel} />
    </form>
  )
}
