'use client'

import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { firstLoopClient } from '../sdk/first-loop-client'
import { SalesAssistantClientError } from '../sdk/sales-assistant-client'
import { completeFirstLoopAttempt } from '../lib/first-loop-attempt'
import {
  acceptFirstLoopReceipt,
  type FirstLoopScope,
  type FirstLoopCommandKind,
  type FrozenFirstLoopMessage,
} from '../lib/first-loop-command'
import type { FirstLoopState } from '../types/first-loop.schemas'

export interface PendingFirstLoopAttempt {
  scope: FirstLoopScope
  attemptScope: string
  messageId: string
  kind: FirstLoopCommandKind
  observationId: string
  message?: FrozenFirstLoopMessage | null
}

const REPLAY_GRACE_MS = 15000
const MAX_REPLAYS = 2
function blocksReplay(failure: unknown) {
  return (
    failure instanceof SalesAssistantClientError &&
    ([401, 403, 409].includes(failure.status ?? 0) ||
      failure.code === 'INVALID_RESPONSE')
  )
}
function replayMessage(attempt: PendingFirstLoopAttempt) {
  const value = attempt.message
  return attempt.kind === 'message' &&
    value &&
    value.businessId === attempt.scope.businessId &&
    value.body.flow_id === attempt.scope.state?.flow_id &&
    value.body.client_message_id === attempt.messageId &&
    value.body.response_locale === attempt.scope.locale
    ? value
    : null
}

async function readReceipt(
  attempt: PendingFirstLoopAttempt,
  signal: AbortSignal
) {
  try {
    return await firstLoopClient.receipt(
      attempt.scope.businessId!,
      attempt.scope.state!.flow_id,
      attempt.messageId,
      signal
    )
  } catch (failure) {
    if (failure instanceof SalesAssistantClientError && failure.status === 404)
      return null
    throw failure
  }
}

/** 404 is not absence proof. Safety comes from the current runtime's atomic same-key reservation. */
function receiptReader(attempt: PendingFirstLoopAttempt | null) {
  const reader = { stopped: false, read }
  let misses = 0,
    replays = 0,
    lastReplay = 0
  async function read({ signal }: { signal: AbortSignal }) {
    if (!attempt || reader.stopped || signal.aborted) return null
    try {
      const receipt = await readReceipt(attempt, signal)
      if (receipt) return receipt
    } catch (failure) {
      misses = 0
      if (blocksReplay(failure)) reader.stopped = true
      throw failure
    }
    const message = replayMessage(attempt)
    misses += 1
    if (
      !message ||
      misses < 2 ||
      replays >= MAX_REPLAYS ||
      signal.aborted ||
      Date.now() - Math.max(message.startedAt, lastReplay) < REPLAY_GRACE_MS
    )
      return null
    replays += 1
    lastReplay = Date.now()
    try {
      return await firstLoopClient.message(
        message.businessId,
        message.body,
        signal
      )
    } catch (failure) {
      if (blocksReplay(failure)) reader.stopped = true
      throw failure
    }
  }
  return reader
}

export function useFirstLoopRecovery(
  attempt: PendingFirstLoopAttempt | null,
  recovered: (accepted: boolean, observation: string) => void
) {
  const client = useQueryClient()
  const businessId = attempt?.scope.businessId
  const flowId = attempt?.scope.state?.flow_id
  const messageId = attempt?.messageId
  const reader = useMemo(() => receiptReader(attempt), [attempt])
  const query = useQuery({
    queryKey: [
      'meta-assistant',
      'receipt',
      attempt?.scope.userId,
      businessId,
      flowId,
      attempt?.scope.locale,
      messageId,
      attempt?.observationId,
    ],
    queryFn: reader.read,
    enabled: Boolean(attempt),
    retry: false,
    refetchInterval: () => (reader.stopped ? false : 3000),
  })
  useEffect(() => {
    // A 404 is a point-in-time miss: the original POST may still be executing.
    // Preserve its identity and pending promise; only an exact receipt proves acceptance.
    if (!attempt || !query.isSuccess || !query.data) return
    const receipt = query.data
    completeFirstLoopAttempt(attempt.attemptScope, attempt.messageId)
    client.setQueryData<FirstLoopState>(attempt.scope.queryKey, previous =>
      acceptFirstLoopReceipt(previous, receipt, attempt.kind)
    )
    recovered(true, attempt.observationId)
    void client.invalidateQueries({ queryKey: attempt.scope.queryKey })
  }, [attempt, client, query.data, query.isSuccess, recovered])
}
