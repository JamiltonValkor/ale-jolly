'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useReconciledBusinessId } from '@/hooks/queries'
import { Skeleton } from '@/components/ui/skeleton'
import { SaButton } from '@/shared/components/sa-button'
import { useAgentActions } from '../hooks/use-autonomous-team-queries'
import type { AgentAction } from '../types'
import { AgentActivityItem } from './agent-activity-item'
import { AgentActivityMetaList } from './agent-activity-meta-list'
import { AgentTraceSheet, type AgentTraceTarget } from './agent-trace-sheet'

type ActivityFilter = 'all' | 'approval' | 'failed'
const FILTERS: ActivityFilter[] = ['all', 'approval', 'failed']

const matches = (action: AgentAction, filter: ActivityFilter) =>
  filter === 'all' ||
  (filter === 'approval'
    ? action.state === 'awaiting_approval'
    : action.state === 'failed' || action.state === 'partial')

/** Junta las páginas sin repetir acciones (un cursor nunca duplica, pero se blinda). */
export function mergePages(
  pages: Array<{ available: boolean; data?: { items: AgentAction[] } }>
) {
  const seen = new Set<string>()
  const items: AgentAction[] = []
  for (const page of pages)
    for (const action of page.data?.items ?? [])
      if (!seen.has(action.agent_action_id)) {
        seen.add(action.agent_action_id)
        items.push(action)
      }
  return items
}

interface Props {
  businessId?: string | null
  /** Quien la contiene ya pone título y descripción (Meta Assistant). */
  hideHeader?: boolean
  /** Reemplaza la línea de «aún no ha hecho nada». */
  emptySlot?: ReactNode
  /** `meta`: el lenguaje visual de Meta Assistant (tarjetas por día, chips). */
  appearance?: 'classic' | 'meta'
}

/**
 * Pestaña «Actividad» de «Mi asistente» (AAF-005): lo que hizo el equipo
 * autónomo en el negocio, leído solo de la traza del agente (D28; no mezcla
 * lifecycle ni lo del dueño), más reciente primero, con «Ver más».
 */
export function AgentActivityFeed({
  businessId,
  hideHeader = false,
  emptySlot,
  appearance = 'classic',
}: Props) {
  const meta = appearance === 'meta'
  const t = useTranslations('autonomousTeam.activity')
  const selected = useReconciledBusinessId()
  const business = businessId === undefined ? selected : businessId
  const query = useAgentActions(business)
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [trace, setTrace] = useState<AgentTraceTarget | null>(null)
  const pages = query.data?.pages
  const items = useMemo(() => mergePages(pages ?? []), [pages])
  const visible = items.filter(action => matches(action, filter))
  const openTrace = (picked: AgentAction, phrase: string) =>
    setTrace({
      campaignId: picked.campaign_id,
      agentActionId: picked.agent_action_id,
      campaignName: phrase,
    })

  if (query.isPending)
    return (
      <div
        role="status"
        aria-label={t('loading')}
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  if (query.isError)
    return meta ? (
      <div role="alert" className="mu-card flex flex-col items-start gap-3 p-5">
        <p className="text-[14.5px] text-[var(--mu-text)]">{t('error')}</p>
        <button
          type="button"
          className="mu-btn"
          onClick={() => void query.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    ) : (
      <p role="alert" className="text-sa-text-secondary text-sm">
        {t('error')}
      </p>
    )
  if (pages?.[0] && !pages[0].available)
    return meta ? (
      <div className="mu-card p-5">
        <p className="mu-label">{t('title')}</p>
        <p className="mt-2 text-[14.5px] text-[var(--mu-text-2)]">
          {t('comingSoonBody')}
        </p>
      </div>
    ) : (
      <p className="text-sa-text-secondary text-sm">{t('comingSoon')}</p>
    )

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby={hideHeader ? undefined : 'agent-activity-title'}
      aria-label={hideHeader ? t('title') : undefined}
    >
      {hideHeader ? null : (
        <div className="flex flex-col gap-1">
          <h2
            id="agent-activity-title"
            className="text-sa-text-primary text-lg font-semibold"
          >
            {t('title')}
          </h2>
          <p className="text-sa-text-secondary text-sm">{t('description')}</p>
        </div>
      )}
      {items.length === 0 ? (
        (emptySlot ?? (
          <p className="text-sa-text-secondary text-sm">{t('empty')}</p>
        ))
      ) : (
        <>
          <div
            role="group"
            aria-label={t('filters.label')}
            className="flex flex-wrap gap-2"
          >
            {FILTERS.map(option =>
              meta ? (
                <button
                  key={option}
                  type="button"
                  className={filter === option ? 'mu-btn mu-btn-p' : 'mu-btn'}
                  aria-pressed={filter === option}
                  onClick={() => setFilter(option)}
                >
                  {t(`filters.${option}`)}
                </button>
              ) : (
                <SaButton
                  key={option}
                  type="button"
                  size="sm"
                  variant={filter === option ? 'primary' : 'outline'}
                  aria-pressed={filter === option}
                  onClick={() => setFilter(option)}
                >
                  {t(`filters.${option}`)}
                </SaButton>
              )
            )}
          </div>
          {visible.length && meta ? (
            <AgentActivityMetaList actions={visible} onOpenTrace={openTrace} />
          ) : visible.length ? (
            <ul className="flex flex-col">
              {visible.map(action => (
                <AgentActivityItem
                  key={action.agent_action_id}
                  action={action}
                  onOpenTrace={openTrace}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sa-text-secondary text-sm">
              {t('filteredEmpty')}
            </p>
          )}
          {query.hasNextPage && meta ? (
            <button
              type="button"
              className="mu-btn self-center"
              aria-busy={query.isFetchingNextPage || undefined}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
            </button>
          ) : query.hasNextPage ? (
            <SaButton
              type="button"
              variant="outline"
              className="self-center"
              isLoading={query.isFetchingNextPage}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
            </SaButton>
          ) : null}
        </>
      )}
      <AgentTraceSheet
        target={trace}
        onOpenChange={open => {
          if (!open) setTrace(null)
        }}
      />
    </section>
  )
}
