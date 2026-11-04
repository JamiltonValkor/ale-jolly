'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { CaretDown, CaretUp } from '@phosphor-icons/react'
import { SaBadge } from '@/shared/components/sa-badge'
import { useAgentAction } from '../hooks/use-autonomous-team-queries'
import { agentActionCopy } from '../lib/agent-action-copy'
import { STATE_TONE, stateKey } from '../lib/agent-trace'
import type { AgentAction } from '../types'
import { AgentActionFields } from './agent-action-fields'

interface Props {
  action: AgentAction
  defaultOpen?: boolean
}

/** Frase de la acción (AAF-005) traducida: `request_summary` si el kind es nuevo. */
export function useAgentActionPhrase(action: AgentAction): string {
  const t = useTranslations('autonomousTeam.kind')
  const format = useFormatter()
  const copy = agentActionCopy(action, (amount, currency) =>
    format.number(amount, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    })
  )
  return copy.kind === 'text' ? copy.text : t(copy.key as 'other', copy.values)
}

/** Una acción de la traza; el detalle (pasos, gasto) se lee al abrirla. */
export function AgentActionTrace({ action, defaultOpen = false }: Props) {
  const t = useTranslations('autonomousTeam')
  const [open, setOpen] = useState(defaultOpen)
  const detail = useAgentAction(open ? action.agent_action_id : null)
  const phrase = useAgentActionPhrase(action)
  const state = stateKey(action.state)
  return (
    <article className="border-sa-border-default flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sa-text-primary text-sm font-medium break-words">
          {phrase}
        </p>
        <SaBadge variant={STATE_TONE[state]} size="sm" className="shrink-0">
          {t(`state.${state}`)}
        </SaBadge>
      </div>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="text-sa-agent flex w-fit items-center gap-1 text-xs underline-offset-2 hover:underline"
      >
        {open ? t('trace.hideDetail') : t('trace.showDetail')}
        {open ? (
          <CaretUp className="size-3" aria-hidden="true" />
        ) : (
          <CaretDown className="size-3" aria-hidden="true" />
        )}
      </button>
      {open ? <ActionDetail query={detail} /> : null}
    </article>
  )
}

function ActionDetail({ query }: { query: ReturnType<typeof useAgentAction> }) {
  const t = useTranslations('autonomousTeam.trace')
  if (query.isPending)
    return <p className="text-sa-text-secondary text-sm">{t('loading')}</p>
  if (query.isError)
    return (
      <p role="alert" className="text-sa-text-secondary text-sm">
        {t('error')}
      </p>
    )
  if (!query.data.available)
    return <p className="text-sa-text-secondary text-sm">{t('unavailable')}</p>
  return <AgentActionFields detail={query.data.data} />
}
