'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FirstLoopCommandError,
  type FirstLoopScope,
  type FirstLoopCommandKind,
} from '../lib/first-loop-command'
import { SalesAssistantClientError } from '../sdk/sales-assistant-client'
import {
  useFirstLoopRecovery,
  type PendingFirstLoopAttempt,
} from './use-first-loop-recovery'

type PendingResolution = { key: string; resolve: (accepted: boolean) => void }
type ErrorKind = 'uncertain' | 'stale' | 'unavailable'
interface CommandFailure {
  key: string
  code: ErrorKind
  attempt: PendingFirstLoopAttempt | null
}
const scopeKey = (scope: FirstLoopScope) => JSON.stringify(scope.queryKey)
function commandFailure(
  failure: unknown,
  scope: FirstLoopScope,
  kind: FirstLoopCommandKind
): CommandFailure {
  const wrapped = failure instanceof FirstLoopCommandError ? failure : null
  const reason = wrapped?.failure ?? failure
  const code =
    reason instanceof SalesAssistantClientError && reason.status === 409
      ? 'stale'
      : reason instanceof SalesAssistantClientError &&
          reason.status !== null &&
          reason.status < 500 &&
          ![408, 429].includes(reason.status)
        ? 'unavailable'
        : 'uncertain'
  const attempt = wrapped
    ? {
        scope,
        kind,
        attemptScope: wrapped.attemptScope,
        messageId: wrapped.messageId,
        message: wrapped.messageReplay,
        observationId: crypto.randomUUID(),
      }
    : null
  return { key: scopeKey(scope), code, attempt }
}

/** Pending promises belong to their original context; switching scope cannot lock the next chat. */
export function useFirstLoopCommandOutcome(scope: FirstLoopScope) {
  const key = scopeKey(scope)
  const [error, setError] = useState<CommandFailure | null>(null)
  const pending = useRef(new Map<string, PendingResolution>())
  const current = error?.key === key ? error : null
  const acknowledge = useCallback((accepted: boolean, observation: string) => {
    pending.current.get(observation)?.resolve(accepted)
    pending.current.delete(observation)
    setError(previous =>
      previous?.attempt?.observationId === observation ? null : previous
    )
  }, [])
  useEffect(() => {
    const callbacks = pending.current
    return () => {
      for (const [id, value] of callbacks) {
        if (value.key === key) {
          value.resolve(false)
          callbacks.delete(id)
        }
      }
    }
  }, [key])
  useFirstLoopRecovery(
    current?.code === 'uncertain' ? current.attempt : null,
    acknowledge
  )
  function capture(
    failure: unknown,
    originalScope: FirstLoopScope,
    kind: FirstLoopCommandKind
  ): Promise<boolean> {
    const next = commandFailure(failure, originalScope, kind)
    setError(next)
    return next.code === 'uncertain' && next.attempt
      ? new Promise(resolve => {
          pending.current.set(next.attempt!.observationId, {
            key: next.key,
            resolve,
          })
        })
      : Promise.resolve(false)
  }
  return {
    mutationError: current?.code ?? null,
    capture,
    reset: () => setError(null),
  }
}
