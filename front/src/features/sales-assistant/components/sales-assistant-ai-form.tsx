'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { cn } from '@/lib/utils'
import { SaButton } from '@/shared/components/sa-button'
import { useSalesAssistantMe } from '../hooks/use-sales-assistant-me'
import { useSalesAssistantProviders } from '../hooks/use-sales-assistant-queries'
import { offeredAiProviders } from '../lib/ai-form-messages'
import { SALES_ASSISTANT_FLAG } from '../lib/feature-flags'
import type { SalesAssistantMe, SalesAssistantProvider } from '../types'
import {
  SalesAssistantAiEditor,
  type SalesAssistantAiConfig,
} from './sales-assistant-ai-editor'

interface Props {
  /** Se llama cuando la prueba da `ok`; `/me` ya se invalidó para el chat. */
  onConfigured?: () => void
  className?: string
}

function savedConfig(
  ai: SalesAssistantMe['ai'] | undefined
): SalesAssistantAiConfig | null {
  if (!ai?.configured || !ai.provider || !ai.model) return null
  return { provider: ai.provider, model: ai.model }
}

function LoadingState() {
  const t = useTranslations('salesAssistant.ai.providers')
  return (
    <div
      role="status"
      aria-label={t('loading')}
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-10 w-full rounded-xl" />
      <Skeleton className="h-10 w-full rounded-xl" />
      <Skeleton className="h-10 w-40 rounded-full" />
    </div>
  )
}

interface SummaryProps {
  config: SalesAssistantAiConfig
  providers: SalesAssistantProvider[] | undefined
  justSaved: boolean
  onReplace: () => void
}

/** IA ya configurada: proveedor y modelo, nunca la key. */
function AiSummary({ config, providers, justSaved, onReplace }: SummaryProps) {
  const t = useTranslations('salesAssistant.ai')
  const label =
    providers?.find(provider => provider.id === config.provider)?.label ??
    config.provider
  return (
    <div className="border-sa-border-default bg-sa-surface-card flex flex-col gap-3 rounded-2xl border p-4">
      {justSaved && (
        <p role="status" className="text-sa-state-success text-sm font-medium">
          {t('results.ok')}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-sa-text-primary font-medium">{t('summary.title')}</p>
        <p className="text-sa-text-secondary text-sm">
          {t('summary.detail', { provider: label, model: config.model })}
        </p>
        <p className="text-sa-text-muted text-xs">{t('summary.keyHidden')}</p>
      </div>
      <SaButton
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={onReplace}
      >
        {t('actions.replaceKey')}
      </SaButton>
    </div>
  )
}

interface EditorSlotProps {
  initial: SalesAssistantAiConfig | null
  onSaved: (config: SalesAssistantAiConfig) => void
  onCancel?: () => void
}

/** Carga la lista de proveedores y monta el editor, o explica por qué no. */
function EditorSlot({ initial, onSaved, onCancel }: EditorSlotProps) {
  const t = useTranslations('salesAssistant.ai')
  const providers = useSalesAssistantProviders()
  if (providers.isPending) return <LoadingState />
  if (providers.isError)
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sa-text-secondary text-sm">
          {t('providers.error')}
        </p>
        <SaButton
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void providers.refetch()}
        >
          {t('actions.retry')}
        </SaButton>
      </div>
    )
  const offered = offeredAiProviders(providers.data)
  if (offered.length === 0)
    return (
      <p className="text-sa-text-secondary text-sm">{t('providers.empty')}</p>
    )
  return (
    <SalesAssistantAiEditor
      providers={offered}
      initialProvider={initial?.provider ?? null}
      initialModel={initial?.model ?? null}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
}

/** Resumen o editor: qué se muestra y qué pasa al guardar o reemplazar. */
function useAiFormState(onConfigured: Props['onConfigured']) {
  const me = useSalesAssistantMe()
  const [replacing, setReplacing] = useState(false)
  const [justSaved, setJustSaved] = useState<SalesAssistantAiConfig>()
  const [celebrate, setCelebrate] = useState(false)

  function handleSaved(config: SalesAssistantAiConfig) {
    setJustSaved(config)
    setCelebrate(true)
    setReplacing(false)
    onConfigured?.()
  }

  function startReplacing() {
    setCelebrate(false)
    setReplacing(true)
  }

  return {
    loading: me.isPending,
    current: justSaved ?? savedConfig(me.data?.ai),
    replacing,
    celebrate,
    handleSaved,
    startReplacing,
    stopReplacing: () => setReplacing(false),
  }
}

function SalesAssistantAiFormContent({ onConfigured, className }: Props) {
  const t = useTranslations('salesAssistant.ai')
  const titleId = useId()
  const providers = useSalesAssistantProviders()
  const { loading, current, replacing, celebrate, ...actions } =
    useAiFormState(onConfigured)

  let body
  if (loading) body = <LoadingState />
  else if (current && !replacing)
    body = (
      <AiSummary
        config={current}
        providers={providers.data}
        justSaved={celebrate}
        onReplace={actions.startReplacing}
      />
    )
  else
    body = (
      <EditorSlot
        initial={current}
        onSaved={actions.handleSaved}
        onCancel={current ? actions.stopReplacing : undefined}
      />
    )

  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex flex-col gap-4', className)}
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-sa-text-primary text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sa-text-secondary text-sm">{t('description')}</p>
      </div>
      {body}
    </section>
  )
}

/**
 * «Configura tu IA» (OCF-004). Autónomo: lee `/me` y `/providers` por sus
 * hooks. El panel lo monta con `step=configure_ai` y también sirve desde
 * ajustes con el asistente `ready` («Reemplazar clave»). Sin la bandera no
 * renderiza nada ni consulta el servicio.
 */
export function SalesAssistantAiForm(props: Props) {
  const enabled = useFeatureFlag(SALES_ASSISTANT_FLAG)
  if (!enabled) return null
  return <SalesAssistantAiFormContent {...props} />
}
