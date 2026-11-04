'use client'

import { useMemo, useRef } from 'react'

/** Al cerrar un panel, el foco vuelve a la fila (o botón) que lo abrió. */
export function useReturnFocus() {
  const trigger = useRef<HTMLElement | null>(null)
  return useMemo(
    () => ({
      remember: () => {
        const active = document.activeElement
        trigger.current = active instanceof HTMLElement ? active : null
      },
      restore: () => {
        const element = trigger.current
        requestAnimationFrame(() => {
          if (element?.isConnected) element.focus()
        })
      },
    }),
    []
  )
}
