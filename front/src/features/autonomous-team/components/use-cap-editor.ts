'use client'

// TDD-SKIP: lógica compartida de los dos editores del tope de créditos; la cubren agent-limits-panel.test.tsx y agent-limits-compact.test.tsx
import { useState } from 'react'
import { useUpdateAgentCreditCap } from '../hooks/use-autonomous-team-mutations'

/** Entero ≥ 0 sin signos ni decimales; lo demás → null. */
export function parseCap(raw: string): number | null {
  const value = raw.trim()
  if (!/^\d{1,9}$/.test(value)) return null
  return Number(value)
}

export type CapFeedback = 'saved' | 'saveError' | null

/** Lo que comparten los editores del tope: lo tecleado, confirmar y guardar. */
export function useCapEditor() {
  const update = useUpdateAgentCreditCap()
  const [typed, setTyped] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<CapFeedback>(null)
  const save = () => {
    const value = parseCap(typed)
    setInvalid(value === null)
    setFeedback(null)
    if (value !== null) setConfirming(value)
  }
  const confirm = (value: number) => {
    setConfirming(null)
    update.mutate(value, {
      onSuccess: () => {
        setTyped('')
        setFeedback('saved')
      },
      onError: () => setFeedback('saveError'),
    })
  }
  return {
    typed,
    setTyped,
    invalid,
    confirming,
    cancel: () => setConfirming(null),
    feedback,
    save,
    confirm,
    pending: update.isPending,
  }
}
