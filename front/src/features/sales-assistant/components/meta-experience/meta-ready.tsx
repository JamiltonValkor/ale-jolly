'use client'

import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Play } from '@phosphor-icons/react'
import { useBusinessStore } from '@/store/use-business-store'
import { useFirstLoop } from '../../hooks/use-first-loop'
import {
  useBrainSnapshots,
  useBrainSnapshotV2,
} from '../../hooks/use-orqa-queries'
import { useStartSalesAssistantMutation } from '../../hooks/use-sales-assistant-mutations'
import { useStockStatus, useStockSummary } from '../../hooks/use-stock'
import { salesAssistantErrorKey } from '../../lib/error-messages'
import { buildLoopModel } from '../../lib/meta-experience/loop-model'
import { buildTeamModel } from '../../lib/meta-experience/team-model'
import { dayPart, daysSince, firstName } from '../../lib/meta-experience/time'
import { brainCounts } from '../../lib/meta-experience/today-stats'
import type { SalesAssistantMe } from '../../types'
import type { CompanionLink } from './meta-channels-card'
import { MetaChat, type ChatPrefill } from './meta-chat'
import { MetaTabPanel, MetaTabs } from './meta-tabs'
import { MetaTabHelp } from './meta-tab-help'
import { robotPairingCodeFromQuery } from '../../lib/robot-pairing-code'
import { MetaTodayView } from './meta-today-view'
import { useMetaShortcuts } from './use-meta-shortcuts'
import { useMetaTab } from './use-meta-tab'
import { useStockBusinessLink } from './stock/use-stock-business-link'
import {
  META_TABS,
  type MetaTab,
  type RenderCompanion,
  type RenderComposer,
  type RenderFace,
} from './types'

/** Carga diferida: con Stock oculto, ni un byte de la pantalla llega al navegador. */
const StockPanel = dynamic(
  () => import('./stock/stock-panel').then(mod => mod.StockPanel),
  { ssr: false }
)

export interface PairingRenderInput {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialCode: string | null
}

export interface MetaReadySlots {
  brainSlot?: ReactNode
  limitsSlot?: ReactNode
  activitySlot?: ReactNode
  approvalsSlot?: ReactNode
  companion?: CompanionLink | null
  renderPairing?: (input: PairingRenderInput) => ReactNode
  renderCompanion?: RenderCompanion
  renderFace?: RenderFace
  renderComposer?: RenderComposer
}

interface Props extends MetaReadySlots {
  me: SalesAssistantMe
  stopped: boolean
  /** El marco pone las pestañas en su dock y el «?» de la pestaña arriba. */
  renderShell: (tabs: ReactNode, body: ReactNode, help: ReactNode) => ReactNode
}

function StoppedNotice() {
  const t = useTranslations('metaExperience.stopped')
  const tErrors = useTranslations('salesAssistant')
  const start = useStartSalesAssistantMutation()
  return (
    <>
      <div className="mu-card mu-row" role="status">
        <div>
          <p className="text-[14.5px] font-medium">{t('title')}</p>
          <p className="text-[13px] text-[var(--mu-text-ap)]">{t('body')}</p>
        </div>
        <button
          type="button"
          className="mu-btn mu-btn-p ml-auto"
          onClick={() => start.mutate()}
          disabled={start.isPending}
          aria-busy={start.isPending || undefined}
        >
          <Play size={15} weight="light" aria-hidden />
          {t('cta')}
        </button>
      </div>
      {start.error ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--mu-text-ap)]">
          {tErrors(salesAssistantErrorKey(start.error))}
        </p>
      ) : null}
    </>
  )
}

/** Asistente listo (o en pausa): «Hoy», conversar, cerebro, límites, actividad y Stock. */
export function MetaReady({ me, stopped, renderShell, ...slots }: Props) {
  const idPrefix = useId()
  const { data: session } = useSession()
  const business = useBusinessStore(state => state.selectedBusiness)
  const businessId = business?.business_id ?? null
  const businessName = business?.business_name ?? null
  const { data: stockStatus } = useStockStatus()
  const stockIds = stockStatus?.business_ids ?? null
  // En pausa, Stock sigue visible: aprobar no depende de la VM (O-15).
  const stockEnabled = businessId !== null && !!stockIds?.includes(businessId)
  const hidden: MetaTab[] = [
    ...(stopped ? (['chat'] as const) : []),
    ...(stockEnabled ? [] : (['stock'] as const)),
  ]
  const linkPending = useStockBusinessLink(stockIds)
  const [tab, setTab] = useMetaTab('today', hidden, linkPending)
  const flow = useFirstLoop(stopped ? null : businessId)
  const stockSummary = useStockSummary(businessId ?? '', stockEnabled)
  // En pausa el ciclo no se lee: el equipo descansa en vez de «cargando».
  const team =
    stopped || !flow.isLoading
      ? buildTeamModel(flow.state?.work, stockSummary.data, {
          stockEnabled,
          error: flow.isError,
        })
      : null
  const snapshots = useBrainSnapshots(businessId)
  const latest = useBrainSnapshotV2(
    businessId,
    snapshots.data?.items[0]?.version ?? null
  )
  const counts = brainCounts(snapshots.data, latest.data)
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  // El QR trae `?code=`: se captura una vez y sale de la URL.
  const [pairCode] = useState(
    () =>
      robotPairingCodeFromQuery(searchParams.get('code')) ??
      searchParams.get('pair')
  )
  useEffect(() => {
    if (!searchParams.has('code')) return
    const rest = new URLSearchParams(searchParams.toString())
    rest.delete('code')
    const query = rest.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [searchParams, pathname, router])
  const [pairing, setPairing] = useState(pairCode !== null)
  const [prefill, setPrefill] = useState<ChatPrefill | null>(null)
  // Salir de Conversar descarta el pedido: al volver no reaparece.
  const goTo = useCallback(
    (next: MetaTab) => {
      if (next !== 'chat') setPrefill(null)
      setTab(next)
    },
    [setTab]
  )
  const visibleTabs = META_TABS.filter(item => !hidden.includes(item))
  useMetaShortcuts({
    tabs: visibleTabs,
    onTab: goTo,
    onCompose: () => {
      if (stopped) return
      goTo('chat')
      // El panel del chat se monta con el cambio de pestaña: luego el foco.
      window.setTimeout(
        () =>
          document
            .querySelector<HTMLTextAreaElement>('[data-meta-chat] textarea')
            ?.focus(),
        60
      )
    },
  })
  const panels: Record<MetaTab, ReactNode> = {
    today: (
      <MetaTodayView
        ownerName={firstName(session?.user?.name)}
        businessName={businessName}
        dayPart={dayPart(new Date())}
        stats={{ days: daysSince(me.ready_since, new Date()), ...counts }}
        loop={buildLoopModel(flow.state?.work)}
        team={team}
        businessId={businessId}
        onOpenStock={() => {
          const url = new URL(window.location.href)
          url.searchParams.set('vista', 'por-aprobar')
          url.searchParams.delete('propuesta')
          window.history.replaceState(window.history.state, '', url)
          goTo('stock')
        }}
        companion={slots.companion ?? null}
        approvalsSlot={slots.approvalsSlot}
        stopped={stopped}
        onTalk={() => {
          if (!stopped) goTo('chat')
        }}
        onPair={() => setPairing(true)}
        onOpenBrain={() => goTo('brain')}
        onLinkChannel={text => {
          if (stopped) return
          setPrefill({ text, nonce: Date.now() })
          goTo('chat')
        }}
        renderCompanion={slots.renderCompanion}
      />
    ),
    chat: (
      <MetaChat
        prefill={prefill}
        renderFace={slots.renderFace}
        renderCompanion={slots.renderCompanion}
        renderComposer={slots.renderComposer}
      />
    ),
    brain: slots.brainSlot,
    limits: <div className="flex flex-col gap-[18px]">{slots.limitsSlot}</div>,
    activity: (
      <div className="flex flex-col gap-[18px]">{slots.activitySlot}</div>
    ),
    stock: businessId ? (
      <StockPanel
        key={businessId}
        businessId={businessId}
        businessName={businessName}
        renderCompanion={slots.renderCompanion}
      />
    ) : null,
  }
  return (
    <>
      {renderShell(
        <MetaTabs
          value={tab}
          onChange={goTo}
          hidden={hidden}
          idPrefix={idPrefix}
        />,
        <>
          {stopped ? (
            <div className="mt-6">
              <StoppedNotice />
            </div>
          ) : null}
          <MetaTabPanel key={tab} tab={tab} idPrefix={idPrefix}>
            {panels[tab]}
          </MetaTabPanel>
        </>,
        <MetaTabHelp
          tab={tab}
          businessName={businessName}
          tabCount={visibleTabs.length}
          renderFace={slots.renderFace}
        />
      )}
      {slots.renderPairing?.({
        open: pairing,
        onOpenChange: setPairing,
        initialCode: pairCode,
      })}
    </>
  )
}
