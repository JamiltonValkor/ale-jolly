'use client'

import { useTranslations } from 'next-intl'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet'
import { SaAgentBadge } from '@/shared/components/sa-agent-badge'
import {
  useAgentAction,
  useObjectAgentActions,
} from '../hooks/use-autonomous-team-queries'
import type { AgentAction } from '../types'
import { AgentActionFields } from './agent-action-fields'
import { AgentActionTrace } from './agent-action-trace'

export interface AgentTraceTarget {
  /** Sin campaña (p. ej. una pieza suelta) se muestra solo la acción. */
  campaignId: string | null
  /** `authorship.agent_action_id`: la acción que creó la campaña, abierta primero. */
  agentActionId: string | null
  campaignName: string
}

interface Props {
  target: AgentTraceTarget | null
  onOpenChange: (open: boolean) => void
}

/** Primero la acción de la autoría, después el resto (más reciente primero). */
function ordered(items: AgentAction[], primaryId: string | null) {
  const primary = items.filter(item => item.agent_action_id === primaryId)
  return [
    ...primary,
    ...items.filter(item => item.agent_action_id !== primaryId),
  ]
}

/**
 * Hoja lateral con la traza de una campaña del equipo autónomo (AAF-002,
 * MAN-001/016). Lee solo `agent-actions`; nunca infiere del nombre.
 */
export function AgentTraceSheet({ target, onOpenChange }: Props) {
  const t = useTranslations('autonomousTeam.trace')
  const actions = useObjectAgentActions('campaign', target?.campaignId ?? null)
  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent className="border-sa-border-default bg-sa-surface-base w-full p-0 sm:max-w-lg">
        <div className="border-sa-border-default flex flex-col gap-2 border-b p-6">
          <SaAgentBadge />
          <SheetTitle className="text-sa-text-primary text-lg font-semibold">
            {t('title')}
          </SheetTitle>
          {target ? (
            <p className="text-sa-text-secondary text-sm break-words">
              {target.campaignName}
            </p>
          ) : null}
          <SheetDescription className="text-sa-text-tertiary text-xs">
            {t('description')}
          </SheetDescription>
        </div>
        <ScrollArea className="h-[calc(100dvh-160px)] p-6">
          {target && !target.campaignId && target.agentActionId ? (
            <PrimaryAction actionId={target.agentActionId} />
          ) : (
            <TraceBody
              query={actions}
              primaryId={target?.agentActionId ?? null}
            />
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function TraceBody({
  query,
  primaryId,
}: {
  query: ReturnType<typeof useObjectAgentActions>
  primaryId: string | null
}) {
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
  const items = ordered(query.data.data.items, primaryId)
  if (!items.length)
    return primaryId ? (
      <PrimaryAction actionId={primaryId} />
    ) : (
      <p className="text-sa-text-secondary text-sm">{t('empty')}</p>
    )
  return (
    <div className="flex flex-col gap-3">
      {items.map((action, index) => (
        <AgentActionTrace
          key={action.agent_action_id}
          action={action}
          defaultOpen={index === 0}
        />
      ))}
    </div>
  )
}

/** La acción de la autoría cuando la búsqueda por objeto aún no la devuelve. */
function PrimaryAction({ actionId }: { actionId: string }) {
  const t = useTranslations('autonomousTeam.trace')
  const query = useAgentAction(actionId)
  if (query.isPending)
    return <p className="text-sa-text-secondary text-sm">{t('loading')}</p>
  if (query.isError || !query.data.available)
    return <p className="text-sa-text-secondary text-sm">{t('empty')}</p>
  return <AgentActionFields detail={query.data.data} />
}
