'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowClockwise } from '@phosphor-icons/react'
import { MetaUiScope } from '@/shared/meta-ui'
import {
  useReleaseActivationKey,
  useSalesAssistantAccessRecovery,
} from '../../hooks/use-sales-assistant-activation'
import { useSalesAssistantMe } from '../../hooks/use-sales-assistant-me'
import { useMarkSalesAssistantSeen } from '../../hooks/use-sales-assistant-ready-indicator'
import { useSalesAssistantTimezoneSync } from '../../hooks/use-sales-assistant-timezone-sync'
import { useBusinessTypeSync } from '../../hooks/use-business-type-sync'
import { salesAssistantErrorKey } from '../../lib/error-messages'
import {
  resolveSalesAssistantView,
  type SalesAssistantView,
} from '../../lib/panel-view'
import { MetaHelp } from './meta-help'
import { MetaManageMenu } from './meta-manage-menu'
import { MetaPreparing } from './meta-preparing'
import { MetaReady, type MetaReadySlots } from './meta-ready'
import { MetaShell, type MetaShellStatus } from './meta-shell'
import { MetaStart } from './meta-start'

type Props = MetaReadySlots

const SHELL_STATUS: Record<SalesAssistantView, MetaShellStatus | null> = {
  loading: null,
  activate: 'none',
  preparing: 'preparing',
  configureAi: 'preparing',
  failed: 'failed',
  ready: 'ready',
  stopped: 'stopped',
  deleting: 'deleting',
}

function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useTranslations('metaExperience.loadError')
  const tErrors = useTranslations('salesAssistant')
  return (
    <div role="alert" className="mu-card mu-row mt-8">
      <div>
        <p className="text-[14.5px] font-medium">{t('title')}</p>
        <p className="text-[13px] text-[var(--mu-text-ap)]">
          {tErrors(salesAssistantErrorKey(error))}
        </p>
      </div>
      <button type="button" className="mu-btn ml-auto" onClick={onRetry}>
        <ArrowClockwise size={15} weight="light" aria-hidden />
        {t('retry')}
      </button>
    </div>
  )
}

function Loading() {
  const t = useTranslations('salesAssistant.status')
  return (
    <div role="status" aria-label={t('loading')} className="mt-8 grid gap-3">
      <span className="mu-skeleton block h-7 w-1/2" />
      <span className="mu-skeleton block h-4 w-3/4" />
      <span className="mu-skeleton block h-56 w-full rounded-[20px]" />
    </div>
  )
}

/**
 * El área del dashboard deja encoger a sus hijos hasta el alto de la pantalla:
 * sin `shrink-0` el negro termina ahí y lo que sobra queda sobre el fondo de
 * la app. `grow` llena la pantalla cuando el contenido es corto.
 */
const SCOPE_CLASS = 'flex grow shrink-0 flex-col'

/**
 * Meta Assistant con el lenguaje del chat nuevo. Elige la pantalla según
 * `GET /me` (mismo polling y mismas recuperaciones silenciosas que antes):
 * llegada, preparación (con salida si se traba), listo o en pausa, borrando.
 */
export function MetaExperience(slots: Props) {
  const me = useSalesAssistantMe()
  const data = me.data
  useReleaseActivationKey(data?.status, data?.step)
  useSalesAssistantAccessRecovery(data)
  useSalesAssistantTimezoneSync(data)
  useBusinessTypeSync(data?.status)
  useMarkSalesAssistantSeen()
  const tDeleting = useTranslations('metaExperience.deleting')
  const view = resolveSalesAssistantView(data)
  const status = me.error && !data ? null : SHELL_STATUS[view]
  const manage =
    view === 'ready' || view === 'stopped' || view === 'configureAi' ? (
      <MetaManageMenu view={view === 'configureAi' ? 'preparing' : view} />
    ) : null
  // Con pestañas, el «?» explica la actual (lo pone MetaReady).
  const shell = (
    body: ReactNode,
    tabs?: ReactNode,
    showTitle = true,
    help: ReactNode = <MetaHelp />
  ) => (
    <MetaShell
      status={status}
      actions={
        <>
          {help}
          {manage}
        </>
      }
      tabs={tabs}
      showTitle={showTitle}
    >
      {body}
    </MetaShell>
  )
  let content: ReactNode
  if (!data)
    content = shell(
      me.error ? (
        <LoadError error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <Loading />
      )
    )
  else if (view === 'activate')
    content = shell(
      <MetaStart renderCompanion={slots.renderCompanion} />,
      undefined,
      false
    )
  else if (view === 'preparing' || view === 'configureAi' || view === 'failed')
    content = shell(
      <MetaPreparing
        step={view === 'configureAi' ? 'configure_ai' : data.step}
        slow={view === 'configureAi' ? false : data.slow}
        failed={view === 'failed'}
        onCheckAgain={() => void me.refetch()}
        renderCompanion={slots.renderCompanion}
      />,
      undefined,
      false
    )
  else if (view === 'ready' || view === 'stopped')
    content = (
      <MetaReady
        me={data}
        stopped={view === 'stopped'}
        renderShell={(tabs, body, help) => shell(body, tabs, false, help)}
        {...slots}
      />
    )
  else
    content = shell(
      <div role="status" className="mu-card mu-row mt-8">
        <span aria-hidden className="mu-dot mu-halo" />
        <div>
          <p className="text-[14.5px] font-medium">{tDeleting('title')}</p>
          <p className="text-[13px] text-[var(--mu-text-ap)]">
            {tDeleting('body')}
          </p>
        </div>
      </div>
    )
  return <MetaUiScope className={SCOPE_CLASS}>{content}</MetaUiScope>
}
