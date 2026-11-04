'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { SaPageTabs, SaPageTabsContent } from '@/shared/components/sa-page-tabs'

const TAB_VALUES = ['chat', 'brain', 'skills', 'limits', 'activity'] as const
type TabValue = (typeof TAB_VALUES)[number]

interface Props {
  chat: ReactNode
  brain?: ReactNode
  skills?: ReactNode
  /** Límites del equipo autónomo (AAF-004): presupuesto mensual y tope de créditos. */
  limits?: ReactNode
  /** Lo que hizo el equipo autónomo (AAF-005). */
  activity?: ReactNode
  /** Asistente desactivado: el chat no está disponible, Mi cerebro muestra la última foto. */
  chatDisabled?: boolean
}

const isTab = (value: string | null | undefined): value is TabValue =>
  (TAB_VALUES as readonly (string | null | undefined)[]).includes(value)

/** `?tab=` en la URL sin navegar ni hacer scroll (Next sincroniza `useSearchParams`). */
function writeTab(tab: TabValue) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.set('tab', tab)
  window.history.replaceState(window.history.state, '', url)
}

/**
 * Pestañas de «Mi asistente» en `ready` y `stopped` (OSF-001/004, AAF-004/005):
 * Chat, Mi cerebro, Habilidades, Límites y Actividad, leídas y escritas en
 * `?tab=`. Sin slots de ORQA queda solo el chat, como antes.
 */
export function SalesAssistantTabs({
  chat,
  brain,
  skills,
  limits,
  activity,
  chatDisabled = false,
}: Props) {
  const t = useTranslations('salesAssistant.brain.tabs')
  const slots: Record<TabValue, ReactNode> = {
    chat,
    brain,
    skills,
    limits,
    activity,
  }
  const available = (value: TabValue) =>
    value === 'chat' ? !chatDisabled : Boolean(slots[value])
  const requested = useSearchParams()?.get('tab')
  const [tab, setTab] = useState<TabValue>(() =>
    isTab(requested) && available(requested)
      ? requested
      : chatDisabled && brain
        ? 'brain'
        : 'chat'
  )
  if (!brain && !skills && !limits && !activity) return <>{chat}</>
  const tabs = TAB_VALUES.filter(value => value === 'chat' || slots[value]).map(
    value => ({
      value,
      label: t(value),
      ...(value === 'chat' ? { disabled: chatDisabled } : {}),
    })
  )
  return (
    <div className="flex flex-col gap-4">
      <SaPageTabs
        tabs={tabs}
        value={tab}
        onValueChange={value => {
          if (!isTab(value)) return
          setTab(value)
          writeTab(value)
        }}
      >
        {TAB_VALUES.map(value =>
          value === 'chat' || slots[value] ? (
            <SaPageTabsContent key={value} value={value} className="pt-6">
              {slots[value]}
            </SaPageTabsContent>
          ) : null
        )}
      </SaPageTabs>
    </div>
  )
}
