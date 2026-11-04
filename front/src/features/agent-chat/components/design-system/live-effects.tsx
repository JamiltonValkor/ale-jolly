'use client'

import { createElement, type ReactNode } from 'react'
import Script from 'next/script'

interface EffectProps {
  children: ReactNode
  theme?: 'dark' | 'light'
  className?: string
}

/** Original 0b3f6c0 custom element; the slotted button works before JS loads. */
export function AgentMetalRingV2({
  children,
  theme = 'dark',
  className,
  strength,
}: EffectProps & { strength: number }) {
  return (
    <>
      {createElement(
        'metal-ring',
        { theme, strength: String(strength), className },
        children
      )}
      <Script src="/agent-chat/v2/metal-ring.js" strategy="afterInteractive" />
    </>
  )
}

/** Decorative only: no microphone, network requests or session state. */
export function AgentBorderBeamV2({
  children,
  theme = 'dark',
  className,
  active,
}: EffectProps & { active: boolean }) {
  return (
    <>
      {createElement(
        'border-beam',
        { theme, active: String(active), strength: '.75', className },
        children
      )}
      <Script src="/agent-chat/v2/border-beam.js" strategy="afterInteractive" />
    </>
  )
}
