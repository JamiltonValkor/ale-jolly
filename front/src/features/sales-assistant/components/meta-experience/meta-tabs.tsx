'use client'

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { useTranslations } from 'next-intl'
import { motion, useReducedMotion } from 'motion/react'
import {
  Brain,
  ChatsCircle,
  ListChecks,
  Package,
  ShieldCheck,
  SunHorizon,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { META_TABS, type MetaTab } from './types'
import styles from './meta-experience.module.css'

const TAB_ICON: Record<MetaTab, Icon> = {
  today: SunHorizon,
  chat: ChatsCircle,
  brain: Brain,
  limits: ShieldCheck,
  activity: ListChecks,
  stock: Package,
}

const LIGHT_SPRING = {
  type: 'spring',
  visualDuration: 0.38,
  bounce: 0.16,
} as const

interface Props {
  value: MetaTab
  onChange: (tab: MetaTab) => void
  /** Pestañas que no se muestran (p. ej. el chat con el asistente en pausa). */
  hidden?: readonly MetaTab[]
  badges?: Partial<Record<MetaTab, number>>
  idPrefix: string
  className?: string
}

/** El filo del dock se enciende donde está el puntero (como el del chat). */
function followPointer(event: PointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.style.setProperty(
    '--mx',
    `${event.clientX - rect.left}px`
  )
  event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`)
}

/** Flechas, Inicio y Fin del tablist. */
function nextTab(
  tabs: readonly MetaTab[],
  value: MetaTab,
  key: string
): MetaTab | null {
  const index = tabs.indexOf(value)
  if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length]
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[tabs.length - 1]
  return null
}

/**
 * Las pestañas, en un dock flotante al pie con el lenguaje del dock del chat:
 * vidrio, aura, filo que sigue al puntero y una luz que se desliza a lo que
 * tocas y vuelve a la pestaña activa. Teclado de tablist (flechas, Inicio,
 * Fin) y atajos numéricos, uno por pestaña visible.
 */
export function MetaTabs({
  value,
  onChange,
  hidden = [],
  badges = {},
  idPrefix,
  className,
}: Props) {
  const t = useTranslations('metaExperience.tabs')
  const [over, setOver] = useState<MetaTab | null>(null)
  const tabs = META_TABS.filter(tab => !hidden.includes(tab))
  const lit = over && tabs.includes(over) ? over : value
  const refs = useRef<Partial<Record<MetaTab, HTMLButtonElement | null>>>({})
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextTab(tabs, value, event.key)
    if (!next) return
    event.preventDefault()
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className={cn(styles.tabs, className)}
      onPointerLeave={() => setOver(null)}
      onPointerMove={followPointer}
    >
      <span aria-hidden className={styles.dockAura} />
      <span aria-hidden className={styles.dockFilo} />
      {tabs.map((tab, index) => (
        <DockTab
          key={tab}
          tab={tab}
          index={index}
          label={t(tab)}
          selected={tab === value}
          lit={tab === lit}
          badge={badges[tab]}
          idPrefix={idPrefix}
          buttonRef={node => {
            refs.current[tab] = node
          }}
          onSelect={() => onChange(tab)}
          onKeyDown={move}
          onLight={setOver}
        />
      ))}
    </div>
  )
}

interface DockTabProps {
  tab: MetaTab
  index: number
  label: string
  selected: boolean
  /** Lleva la luz del dock (la que toca el puntero o la activa). */
  lit: boolean
  badge?: number
  idPrefix: string
  buttonRef: Ref<HTMLButtonElement>
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onLight: (tab: MetaTab | null) => void
}

function DockTab({
  tab,
  index,
  label,
  selected,
  lit,
  badge,
  idPrefix,
  buttonRef,
  onSelect,
  onKeyDown,
  onLight,
}: DockTabProps) {
  const reduced = useReducedMotion() ?? false
  const TabIcon = TAB_ICON[tab]
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={`${idPrefix}-tab-${tab}`}
      aria-selected={selected}
      aria-controls={`${idPrefix}-panel-${tab}`}
      tabIndex={selected ? 0 : -1}
      aria-keyshortcuts={String(index + 1)}
      className={styles.tab}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onPointerEnter={() => onLight(tab)}
      onFocus={() => onLight(tab)}
      onBlur={() => onLight(null)}
    >
      {lit ? (
        <motion.span
          aria-hidden
          layoutId={`${idPrefix}-dock-light`}
          className={styles.tabLight}
          transition={reduced ? { duration: 0 } : LIGHT_SPRING}
        />
      ) : null}
      <TabIcon
        size={18}
        weight={selected ? 'fill' : 'light'}
        aria-hidden
        className={styles.tabIcon}
      />
      <span className={styles.tabLabel}>{label}</span>
      {/* Después del nombre, para que se lea «Actividad 2». */}
      {badge ? <span className={styles.tabBadge}>{badge}</span> : null}
    </button>
  )
}

interface PanelProps {
  tab: MetaTab
  idPrefix: string
  children: ReactNode
}

/** El contenedor que hace scroll (en el dashboard, el área de contenido). */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight
    )
      return el
  }
  return null
}

/**
 * Cada pestaña abre arriba: las pestañas comparten el scroll de la página y
 * sin esto «Cerebro» abría a la altura donde quedó la anterior (p. ej. al
 * fondo de «Conversar»). Va en `useLayoutEffect` para correr antes que los
 * efectos de la pestaña (el chat baja luego hasta su último mensaje).
 */
export function MetaTabPanel({ tab, idPrefix, children }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const parent = scrollParent(ref.current)
    if (parent) parent.scrollTop = 0
    else window.scrollTo(0, 0)
  }, [])
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={`${idPrefix}-panel-${tab}`}
      aria-labelledby={`${idPrefix}-tab-${tab}`}
      tabIndex={0}
      className={cn(styles.panel, 'mu-rise')}
    >
      {children}
    </div>
  )
}
