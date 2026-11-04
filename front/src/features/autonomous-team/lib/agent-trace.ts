import type { AgentAction, AgentActionDetail, AgentActionStep } from '../types'

/** Lecturas de la traza para pintarla (AAF-002/005). Todo es texto: nunca HTML del agente. */

export const KNOWN_STATES = [
  'requested',
  'awaiting_approval',
  'approved',
  'rejected',
  'executing',
  'succeeded',
  'partial',
  'failed',
] as const
export type KnownState = (typeof KNOWN_STATES)[number] | 'unknown'

export const stateKey = (state: string): KnownState =>
  (KNOWN_STATES as readonly string[]).includes(state)
    ? (state as KnownState)
    : 'unknown'

export type StateTone = 'warning' | 'success' | 'error' | 'default' | 'info'

export const STATE_TONE: Record<KnownState, StateTone> = {
  awaiting_approval: 'warning',
  partial: 'warning',
  succeeded: 'success',
  approved: 'success',
  failed: 'error',
  rejected: 'default',
  requested: 'info',
  executing: 'info',
  unknown: 'default',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export type ApprovalView =
  | 'approved'
  | 'rejected'
  | 'pending'
  | 'notRequired'
  | 'none'

function decisionOf(step: AgentActionStep | undefined): string | null {
  const after = step?.after_value
  if (typeof after === 'string') return after
  if (!isRecord(after)) return null
  const value = after.decision ?? after.status ?? after.outcome
  return typeof value === 'string' ? value : null
}

/** De `state` y del paso `approval_decided` (C-18); sin paso, «Pendiente» o «Sin aprobación registrada». */
export function approvalView(
  action: AgentAction,
  steps: AgentActionStep[] = []
): ApprovalView {
  const decided = steps.find(step => step.step_kind === 'approval_decided')
  const decision = decisionOf(decided)
  if (decision === 'rejected' || action.state === 'rejected') return 'rejected'
  if (decided) return 'approved'
  if (action.state === 'awaiting_approval') return 'pending'
  return action.approval_required ? 'none' : 'notRequired'
}

export interface MetaObject {
  type: string
  id: string
}

/** Objetos creados en Meta (tipo + id), sin repetir. */
export function metaObjects(detail: AgentActionDetail): MetaObject[] {
  const seen = new Set<string>()
  const objects: MetaObject[] = []
  for (const step of detail.steps) {
    if (step.step_kind !== 'meta_object_created' || !step.platform_object_id)
      continue
    const key = `${step.platform_object_type}:${step.platform_object_id}`
    if (seen.has(key)) continue
    seen.add(key)
    objects.push({
      type: step.platform_object_type ?? 'other',
      id: step.platform_object_id,
    })
  }
  return objects
}

/** Error de Meta tal cual: código y mensaje si vienen, si no el texto o el JSON. */
export function formatStepError(error: unknown): string | null {
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return error
  if (!isRecord(error)) return JSON.stringify(error)
  const code = error.code ?? error.error_code
  const message = error.message ?? error.error_user_msg ?? error.error_message
  if (code === undefined && message === undefined) return JSON.stringify(error)
  return [code, message].filter(part => part !== undefined).join(' · ')
}

export const stepErrors = (detail: AgentActionDetail): string[] =>
  detail.steps
    .map(step => formatStepError(step.error))
    .filter((text): text is string => text !== null)

function warningText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return null
  const text = value.message ?? value.code
  return typeof text === 'string' ? text : null
}

/** Advertencias del jurado (D29) del paso de `creative_rendered`, si vienen. */
export function judgeWarnings(detail: AgentActionDetail): string[] {
  if (detail.kind !== 'creative_rendered') return []
  const out: string[] = []
  for (const step of detail.steps) {
    const after = step.after_value
    if (!isRecord(after)) continue
    const judge = isRecord(after.judge) ? after.judge : after
    const warnings = Array.isArray(judge.warnings) ? judge.warnings : []
    for (const warning of warnings) {
      const text = warningText(warning)
      if (text) out.push(text)
    }
  }
  return out
}
