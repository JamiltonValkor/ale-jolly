import {
  firstLoopAttempt,
  completeFirstLoopAttempt,
} from './first-loop-attempt'
import { firstLoopClient } from '../sdk/first-loop-client'
import type {
  FirstLoopAccepted,
  FirstLoopMessageRequest,
  FirstLoopState,
} from '../types/first-loop.schemas'

export type FirstLoopCommandKind = 'message' | 'kickoff' | 'feedback'
export interface FirstLoopScope {
  userId: string | null
  businessId: string | null
  locale: string
  state?: FirstLoopState
  queryKey: readonly unknown[]
}
/** Private text remains only in this mounted UI; replay never rebuilds identity. */
export interface FrozenFirstLoopMessage {
  readonly businessId: string
  readonly body: Readonly<FirstLoopMessageRequest>
  readonly startedAt: number
}
export class FirstLoopCommandError extends Error {
  constructor(
    readonly failure: unknown,
    readonly attemptScope: string,
    readonly messageId: string,
    readonly messageReplay: FrozenFirstLoopMessage | null = null
  ) {
    super('Assistant command not acknowledged')
  }
}

function dispatch(
  scope: FirstLoopScope,
  kind: FirstLoopCommandKind,
  attempt: { id: string; key: string },
  text?: string,
  revision?: number
) {
  const { businessId, state, locale } = scope
  if (!businessId || !state) throw new Error('Not ready')
  if (kind === 'kickoff')
    return firstLoopClient.kickoff(
      businessId,
      { flow_id: state.flow_id, brief_revision: state.brief_revision },
      attempt.key
    )
  if (kind === 'feedback' && state.active_work_id && revision)
    return firstLoopClient.feedback(
      businessId,
      state.active_work_id,
      {
        artifact_revision: revision,
        client_message_id: attempt.id,
        text: text ?? '',
        response_locale: locale,
      },
      attempt.key
    )
  if (kind === 'message')
    return firstLoopClient.message(businessId, {
      flow_id: state.flow_id,
      client_message_id: attempt.id,
      text: text ?? '',
      response_locale: locale,
    })
  throw new Error('Not ready')
}

export async function firstLoopCommand(
  scope: FirstLoopScope,
  kind: FirstLoopCommandKind,
  text?: string,
  revision?: number
): Promise<FirstLoopAccepted> {
  const { businessId, state, locale, userId } = scope
  if (!businessId || !state || !userId) throw new Error('Not ready')
  const payload =
    kind === 'kickoff'
      ? { flow_id: state.flow_id, brief_revision: state.brief_revision }
      : { text, response_locale: locale, revision }
  const attemptScope = `${userId}/${businessId}/${state.flow_id}/${kind}/${kind === 'feedback' ? state.active_work_id : 'intake'}`
  const attempt = await firstLoopAttempt(attemptScope, payload)
  const message: FrozenFirstLoopMessage | null =
    kind === 'message'
      ? Object.freeze({
          businessId,
          startedAt: Date.now(),
          body: Object.freeze({
            flow_id: state.flow_id,
            client_message_id: attempt.id,
            text: (text ?? '').trim(),
            response_locale: locale,
          }),
        })
      : null
  try {
    const receipt = message
      ? await firstLoopClient.message(message.businessId, message.body)
      : await dispatch(scope, kind, attempt, text, revision)
    completeFirstLoopAttempt(attemptScope, attempt.id)
    return receipt
  } catch (failure) {
    throw new FirstLoopCommandError(failure, attemptScope, attempt.id, message)
  }
}

export function acceptFirstLoopReceipt(
  state: FirstLoopState | undefined,
  receipt: FirstLoopAccepted,
  kind: FirstLoopCommandKind
) {
  if (!state || state.flow_id !== receipt.flow_id) return state
  return {
    ...state,
    latest_turn: receipt.turn,
    active_work_id: receipt.work_id ?? state.active_work_id,
    phase:
      kind === 'kickoff'
        ? ('working' as const)
        : kind === 'feedback'
          ? ('reviewing' as const)
          : state.phase,
  }
}
