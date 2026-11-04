'use client'

import { useAssistantRuntime } from '../runtime'

import { useCallback, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BrainFeedbackAction, BusinessType } from '../types'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

/** Mutaciones de ORQA del dueño (OSF-003/004). */

type Decision = 'approve' | 'reject'

/**
 * Aprobar o rechazar una sola vez. La `Idempotency-Key` se genera una vez por
 * decisión y se reusa en un doble clic o un reintento, así el servidor nunca
 * ejecuta dos veces.
 */
export function useDecideApproval(approvalId: string) {
  const {
    keys: salesAssistantKeys,
    orqa: { decideApproval },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const userId = useSalesAssistantUserId() ?? 'anonymous'
  const keys = useRef(new Map<Decision, string>())

  const keyFor = useCallback((decision: Decision) => {
    const existing = keys.current.get(decision)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    keys.current.set(decision, fresh)
    return fresh
  }, [])

  return useMutation({
    mutationFn: (input: Decision | { decision: Decision; code?: string }) => {
      const { decision, code } =
        typeof input === 'string' ? { decision: input, code: undefined } : input
      return decideApproval(approvalId, decision, keyFor(decision), code)
    },
    onSuccess: approval => {
      queryClient.setQueryData(
        salesAssistantKeys.approval(userId, approvalId),
        approval
      )
    },
    // Vencida, desactualizada o ya decidida: se relee para mostrar el estado real.
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: salesAssistantKeys.approval(userId, approvalId),
      })
    },
  })
}

interface SkillProposalInput {
  itemId: string
  action: 'install' | 'uninstall'
}

/** Instalar o desinstalar crea una aprobación; el llamador navega a su página. */
export function useProposeSkill(businessId: string) {
  const {
    orqa: { proposeSkill },
  } = useAssistantRuntime()
  const keys = useRef(new Map<string, string>())
  return useMutation({
    mutationFn: ({ itemId, action }: SkillProposalInput) => {
      const id = `${action}:${itemId}`
      const key = keys.current.get(id) ?? crypto.randomUUID()
      keys.current.set(id, key)
      return proposeSkill(businessId, itemId, action, key)
    },
    // La key vive mientras dura el intento (y sus reintentos); un clic nuevo, otra.
    onSettled: (_data, _error, { itemId, action }) => {
      keys.current.delete(`${action}:${itemId}`)
    },
  })
}

/** Tipo de negocio confirmado por el dueño (MLF-001): cambia las skills del equipo. */
export function useUpdateBusinessProfile(businessId: string) {
  const {
    keys: salesAssistantKeys,
    orqa: { updateBusinessProfile },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const userId = useSalesAssistantUserId() ?? 'anonymous'
  return useMutation({
    mutationFn: (businessType: BusinessType) =>
      updateBusinessProfile(businessId, businessType),
    onSuccess: profile => {
      queryClient.setQueryData(
        salesAssistantKeys.businessProfile(userId, businessId),
        profile
      )
    },
  })
}

/** Confirmar, corregir o «ya no aplica» una memoria (MLF-002). Una key por envío. */
export function useBrainFeedback(businessId: string) {
  const {
    orqa: { sendBrainFeedback },
  } = useAssistantRuntime()
  const keys = useRef(new Map<string, string>())
  return useMutation({
    mutationFn: (input: {
      nodeId: string
      action: BrainFeedbackAction
      text?: string
    }) => {
      const id = `${input.nodeId}:${input.action}:${input.text ?? ''}`
      const key = keys.current.get(id) ?? crypto.randomUUID()
      keys.current.set(id, key)
      return sendBrainFeedback(businessId, input, key)
    },
  })
}

/** Código de un solo uso para aprobar una acción de gasto (MLF-006). */
export function useApprovalCode(approvalId: string) {
  const {
    orqa: { requestApprovalCode },
  } = useAssistantRuntime()
  return useMutation({ mutationFn: () => requestApprovalCode(approvalId) })
}
