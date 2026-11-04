'use client'

// TDD-SKIP: lógica compartida de los dos editores del presupuesto; la cubren agent-limits-panel.test.tsx y agent-limits-compact.test.tsx
import { useState } from 'react'
import { useFormatter } from 'next-intl'
import { useUpdateAgentBudget } from '../hooks/use-autonomous-team-mutations'
import {
  AutonomousTeamClientError,
  type AssistantBffPrefix,
} from '../sdk/autonomous-team-client'
import type { AgentBudget } from '../types'

/** «1.500.000», «1500000» o «120.50» → número; cualquier otra cosa → null. */
export function parseAmount(raw: string): number | null {
  const compact = raw.trim().replace(/\s/g, '')
  if (!/^\d[\d.,]*$/.test(compact)) return null
  // Un separador seguido de 1-2 dígitos al final es decimal; los demás son de miles.
  const decimal = compact.match(/^(.*)[.,](\d{1,2})$/)
  const digits = decimal
    ? `${decimal[1]!.replace(/[.,]/g, '')}.${decimal[2]}`
    : compact.replace(/[.,]/g, '')
  const value = Number(digits)
  return Number.isFinite(value) && value > 0 ? value : null
}

export type BudgetFeedback = 'saved' | 'conflict' | 'saveError' | null

/**
 * Lo que comparten los editores del presupuesto: lo tecleado, la
 * confirmación y el guardado con `If-Match` (un 412 avisa sin perder lo
 * tecleado).
 */
export function useBudgetEditor(
  businessId: string,
  budget: AgentBudget,
  assistantBffPrefix?: AssistantBffPrefix
) {
  const format = useFormatter()
  const update = useUpdateAgentBudget(businessId, assistantBffPrefix)
  const [typed, setTyped] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<BudgetFeedback>(null)
  const money = (amount: number, code: string) =>
    format.number(amount, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    })
  const save = () => {
    const amount = parseAmount(typed)
    setInvalid(amount === null)
    setFeedback(null)
    if (amount !== null) setConfirming(amount)
  }
  const confirm = (code: string, amount: number) => {
    setConfirming(null)
    update.mutate(
      { amount, currency: code, revision: budget.revision },
      {
        onSuccess: () => {
          setTyped('')
          setFeedback('saved')
        },
        onError: error =>
          setFeedback(
            error instanceof AutonomousTeamClientError &&
              error.code === 'BUDGET_REVISION_CONFLICT'
              ? 'conflict'
              : 'saveError'
          ),
      }
    )
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
    money,
    pending: update.isPending,
  }
}
