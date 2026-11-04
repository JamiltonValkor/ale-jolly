'use client'

import { useRef, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { MetaBrainMode } from './types'
import styles from './meta-brain.module.css'

export const MODES: readonly MetaBrainMode[] = ['graph', 'sections', 'changes']

export const tabId = (base: string, mode: MetaBrainMode) =>
  `${base}-tab-${mode}`
export const panelId = (base: string, mode: MetaBrainMode) =>
  `${base}-panel-${mode}`

interface Props {
  mode: MetaBrainMode
  onChange: (mode: MetaBrainMode) => void
  idBase: string
  className?: string
}

const STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/** Control segmentado accesible: tablist con foco itinerante y flechas. */
export function ModeTabs({ mode, onChange, idBase, className }: Props) {
  const t = useTranslations('metaBrain.modes')
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = MODES.indexOf(mode)
    let next = -1
    if (event.key in STEP)
      next = (current + STEP[event.key] + MODES.length) % MODES.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = MODES.length - 1
    if (next < 0) return
    event.preventDefault()
    onChange(MODES[next])
    refs.current[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className={cn(styles.tabs, className)}
    >
      {MODES.map((value, index) => (
        <button
          key={value}
          ref={node => {
            refs.current[index] = node
          }}
          id={tabId(idBase, value)}
          type="button"
          role="tab"
          aria-selected={mode === value}
          aria-controls={panelId(idBase, value)}
          tabIndex={mode === value ? 0 : -1}
          className={styles.tab}
          onClick={() => onChange(value)}
          onKeyDown={move}
        >
          {t(value)}
        </button>
      ))}
    </div>
  )
}
