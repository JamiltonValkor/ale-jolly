'use client'

import { useEffect, useRef, useState } from 'react'

import type { CompanionAction, CompanionMood } from './rig/companion-moods'
import { DEMO_REEL } from './rig/demo-reel'

const ACTION_DELAY_MS = 600

/**
 * `autoplay`: recorre el carrete de demostración. Devuelve el ánimo del paso
 * actual (o null si está apagado) y dispara la acción de cada paso.
 */
export function useDemoReel(
  enabled: boolean,
  onAction: (action: CompanionAction) => void
): CompanionMood | null {
  const [index, setIndex] = useState(0)
  const onActionRef = useRef(onAction)
  useEffect(() => {
    onActionRef.current = onAction
  }, [onAction])

  useEffect(() => {
    if (!enabled) return
    const step = DEMO_REEL[index]
    const timers: ReturnType<typeof setTimeout>[] = []
    if (step.action) {
      const action = step.action
      timers.push(
        setTimeout(() => onActionRef.current(action), ACTION_DELAY_MS)
      )
    }
    timers.push(
      setTimeout(
        () => setIndex(i => (i + 1) % DEMO_REEL.length),
        step.duration * 1000
      )
    )
    return () => timers.forEach(clearTimeout)
  }, [enabled, index])

  return enabled ? DEMO_REEL[index].mood : null
}
