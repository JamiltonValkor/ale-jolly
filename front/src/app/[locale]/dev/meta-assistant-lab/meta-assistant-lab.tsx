'use client'

import { useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  buildLoopModel,
  buildTeamModel,
  MetaActivityEmpty,
  MetaChatView,
  MetaPreparingView,
  MetaShell,
  MetaStartView,
  MetaTabPanel,
  MetaTabHelp,
  MetaTabs,
  MetaTodayView,
  type MetaChatMessage,
  type MetaTab,
  type RenderCompanion,
  type RenderComposer,
  type RenderFace,
} from '@/features/sales-assistant'
import {
  AgentActivityMetaList,
  BudgetCardView,
  CreditsCardView,
  type AgentAction,
} from '@/features/autonomous-team'
import { MetaUiScope } from '@/shared/meta-ui'

export type LabScreen =
  | 'start'
  | 'start-choose'
  | 'preparing'
  | 'stuck'
  | 'failed'
  | 'today'
  | 'today-new'
  | 'today-paired'
  | 'chat'
  | 'chat-empty'
  | 'limits'
  | 'limits-set'
  | 'activity'
  | 'activity-empty'

const LAB_NOW = '2026-11-03T15:00:00.000Z'

const LAB_STOCK = {
  unidades_esperadas: 50,
  diferencias_por_resolver: 1,
  propuestas_pendientes: 2,
  pedidos_en_curso: 1,
  ultimo_conteo_en: LAB_NOW,
  moneda: 'COP',
  simulado: true,
}

const WORK = {
  revision: 3,
  status: 'running',
  projection: { status: 'fresh', observed_at: LAB_NOW, cursor: null },
  tasks: [
    {
      id: 't1',
      profile: 'investigador',
      stage: 'research',
      status: 'completed',
      title: 'Tu competencia en Chapinero: 6 pastelerías',
      updated_at: LAB_NOW,
    },
    {
      id: 't2',
      profile: 'estratega',
      stage: 'strategy',
      status: 'running',
      title: 'Ángulo: tortas para cumpleaños de oficina',
      updated_at: LAB_NOW,
    },
    {
      id: 't3',
      profile: 'estructurador',
      stage: 'structure',
      status: 'queued',
      title: 'Estructura de campaña',
      updated_at: null,
    },
    {
      id: 't4',
      profile: 'analista',
      stage: 'analysis',
      status: 'blocked',
      title: 'Falta el reporte de ventas de octubre',
      updated_at: LAB_NOW,
    },
  ],
  artifacts: [
    {
      title: 'Tu competencia en Chapinero: 6 pastelerías y qué venden',
      stage: 'research',
    },
    {
      title: 'Apuesta: tortas personalizadas para cumpleaños de oficina',
      stage: 'strategy',
    },
  ],
} as unknown as Parameters<typeof buildLoopModel>[0]

const MESSAGES: MetaChatMessage[] = [
  { id: '1', role: 'user', text: '¿Cómo van mis ventas esta semana?' },
  {
    id: '2',
    role: 'assistant',
    text: 'Van mejor que la semana pasada: 14 pedidos contra 9. La apuesta de tortas para cumpleaños de oficina trajo 5 de ellos, con un costo de COP 18.000 por pedido.',
  },
  { id: '3', role: 'user', text: 'Súbele un poco a esa campaña' },
]

const noop = () => undefined

const action = (patch: Partial<AgentAction>): AgentAction => ({
  agent_action_id: 'lab-1',
  business_id: 'lab',
  trace_id: 'run-1',
  kind: 'pause',
  subject_type: 'ad_set',
  subject_id: null,
  campaign_id: null,
  bet_ref: null,
  skill_ref: null,
  request_summary: null,
  request_args: { object_type: 'ad_set', object_name: 'Tortas de oficina' },
  approval_required: false,
  approval_id: null,
  state: 'succeeded',
  outcome_summary: null,
  created_at: LAB_NOW,
  executed_at: LAB_NOW,
  ...patch,
})

const ACTIONS: AgentAction[] = [
  action({
    agent_action_id: 'lab-1',
    kind: 'budget_change',
    state: 'awaiting_approval',
    approval_required: true,
    approval_id: 'ap-1',
    request_args: { object_type: 'campaign', object_name: 'Tortas de oficina' },
  }),
  action({
    agent_action_id: 'lab-2',
    outcome_summary: 'El conjunto gastaba sin ventas hace 3 días.',
  }),
  action({
    agent_action_id: 'lab-3',
    kind: 'launch',
    state: 'failed',
    created_at: '2026-11-02T20:10:00.000Z',
    outcome_summary: 'Meta rechazó el anuncio: el texto promete resultados.',
  }),
]

const labForm = (label: string, inputMode: 'decimal' | 'numeric') => ({
  label,
  placeholder: inputMode === 'decimal' ? '1.500.000' : '200',
  value: '',
  onChange: noop,
  pending: false,
  onSubmit: noop,
  inputMode,
})

interface ReadyProps {
  tab: MetaTab
  renderFace?: RenderFace
  children: ReactNode
}

/** Pantalla del lab para cada pestaña del dock; Cerebro vive en su propio lab. */
const TAB_SCREEN: Partial<Record<MetaTab, LabScreen>> = {
  today: 'today',
  chat: 'chat',
  limits: 'limits',
  activity: 'activity',
}

/** El dock del lab navega: cambia `?screen=` y conserva `?companion=`. */
function useLabNavigation() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  return (tab: MetaTab) => {
    if (tab === 'brain') {
      router.push(pathname.replace('meta-assistant-lab', 'meta-brain-lab'))
      return
    }
    const screen = TAB_SCREEN[tab]
    if (!screen) return
    const next = new URLSearchParams(params.toString())
    next.set('screen', screen)
    router.push(`${pathname}?${next.toString()}`)
  }
}

function Ready({ tab, renderFace, children }: ReadyProps) {
  const [current, setCurrent] = useState(tab)
  const navigate = useLabNavigation()
  return (
    <MetaShell
      status="ready"
      showTitle={false}
      actions={
        <>
          <MetaTabHelp
            tab={current}
            businessName="Dulce Hogar"
            renderFace={renderFace}
          />
          <button type="button" className="mu-btn mu-btn-ghost">
            ··· Administrar
          </button>
        </>
      }
      tabs={
        <MetaTabs
          value={current}
          onChange={next => {
            setCurrent(next)
            navigate(next)
          }}
          idPrefix="lab"
          badges={{ activity: 2 }}
        />
      }
    >
      <MetaTabPanel tab={current} idPrefix="lab">
        {children}
      </MetaTabPanel>
    </MetaShell>
  )
}

interface Props {
  screen: LabScreen
  renderCompanion?: RenderCompanion
  renderFace?: RenderFace
  renderComposer?: RenderComposer
}

/** Laboratorio de Meta Assistant: cada pantalla con datos de muestra. */
export function MetaAssistantLab({
  screen,
  renderCompanion,
  renderFace,
  renderComposer,
}: Props) {
  const [draft, setDraft] = useState('')
  const preparing = (
    step: 'installing_agent' | 'preparing_access',
    extra: Partial<Parameters<typeof MetaPreparingView>[0]> = {}
  ) => (
    <MetaShell status={extra.failed ? 'failed' : 'preparing'} showTitle={false}>
      <MetaPreparingView
        businessName="Dulce Hogar"
        step={step}
        failed={false}
        alert="none"
        elapsedMinutes={2}
        onRetryAccess={noop}
        retrying={false}
        onCheckAgain={noop}
        renderCompanion={renderCompanion}
        {...extra}
      />
    </MetaShell>
  )
  const today = (fresh: boolean, paired = false) => (
    <Ready tab="today" renderFace={renderFace}>
      <MetaTodayView
        ownerName="Nicolás"
        businessName="Dulce Hogar"
        dayPart="afternoon"
        stats={
          fresh
            ? { days: 0, ideas: null, bets: null, learned: null }
            : { days: 27, ideas: 312, bets: 4, learned: 18 }
        }
        loop={buildLoopModel(fresh ? null : WORK)}
        team={buildTeamModel(fresh ? null : WORK, LAB_STOCK, {
          stockEnabled: true,
        })}
        businessId="lab"
        companion={
          paired ? { paired: true, deviceName: 'Compañero de Nicolás' } : null
        }
        onTalk={noop}
        onPair={noop}
        onOpenBrain={noop}
        onLinkChannel={noop}
        renderCompanion={renderCompanion}
      />
    </Ready>
  )
  const chat = (empty: boolean) => (
    <Ready tab="chat" renderFace={renderFace}>
      <MetaChatView
        messages={empty ? [] : MESSAGES}
        historyStatus="ready"
        busy={!empty}
        canSend
        turnFailed={false}
        errorMessage={null}
        draft={draft}
        onDraftChange={setDraft}
        onSend={noop}
        onRetryHistory={noop}
        textLimit={8000}
        renderFace={renderFace}
        renderCompanion={renderCompanion}
        renderComposer={renderComposer}
      />
    </Ready>
  )
  // Las tarjetas de «Límites» con datos de muestra (en la app las llenan los
  // contenedores de autonomous-team).
  const limits = (set: boolean) => (
    <Ready tab="limits" renderFace={renderFace}>
      <div className="grid gap-4 md:grid-cols-2">
        <BudgetCardView
          state="ready"
          amount={set ? '1.500.000 COP' : null}
          month="octubre"
          connect={!set}
          form={set ? labForm('Pauta al mes en COP', 'decimal') : undefined}
        />
        <CreditsCardView
          state="ready"
          cap={set ? 200 : null}
          used={set ? 50 : 0}
          resets="1 nov"
          form={labForm('Créditos al mes', 'numeric')}
        />
      </div>
    </Ready>
  )
  const screens: Record<LabScreen, () => ReactNode> = {
    start: () => (
      <MetaShell status="none" showTitle={false}>
        <MetaStartView
          businessName="Dulce Hogar"
          type="physical_product"
          prefilled
          onChooseType={noop}
          onActivate={noop}
          busy={false}
          errorMessage={null}
          renderCompanion={renderCompanion}
        />
      </MetaShell>
    ),
    'start-choose': () => (
      <MetaShell status="none" showTitle={false}>
        <MetaStartView
          businessName="Dulce Hogar"
          type={null}
          prefilled={false}
          onChooseType={noop}
          onActivate={noop}
          busy={false}
          errorMessage={null}
          renderCompanion={renderCompanion}
        />
      </MetaShell>
    ),
    preparing: () => preparing('installing_agent'),
    stuck: () =>
      preparing('preparing_access', { alert: 'stuck', elapsedMinutes: 4 }),
    failed: () =>
      preparing('installing_agent', { failed: true, elapsedMinutes: 9 }),
    today: () => today(false),
    'today-new': () => today(true),
    'today-paired': () => today(false, true),
    chat: () => chat(false),
    'chat-empty': () => chat(true),
    limits: () => limits(false),
    'limits-set': () => limits(true),
    activity: () => (
      <Ready tab="activity" renderFace={renderFace}>
        <AgentActivityMetaList actions={ACTIONS} onOpenTrace={noop} />
      </Ready>
    ),
    'activity-empty': () => (
      <Ready tab="activity" renderFace={renderFace}>
        <MetaActivityEmpty renderCompanion={renderCompanion} />
      </Ready>
    ),
  }
  return (
    <MetaUiScope className="flex min-h-dvh flex-col">
      {screens[screen]()}
    </MetaUiScope>
  )
}
