'use client'

import { useEffect } from 'react'
import type { MetaTab } from './types'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

interface Options {
  tabs: readonly MetaTab[]
  onTab: (tab: MetaTab) => void
  /** `/`: ir a conversar con el cursor en el compositor. */
  onCompose: () => void
}

/**
 * Atajos de Meta Assistant: `/` para escribirle y un número por pestaña
 * visible para cambiar de sección. Nunca mientras se escribe en un campo ni con modificadores.
 */
export function useMetaShortcuts({ tabs, onTab, onCompose }: Options) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return
      if (isTyping(event.target)) return
      if (event.key === '/') {
        event.preventDefault()
        onCompose()
        return
      }
      const index = Number(event.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < tabs.length)
        onTab(tabs[index])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabs, onTab, onCompose])
}
