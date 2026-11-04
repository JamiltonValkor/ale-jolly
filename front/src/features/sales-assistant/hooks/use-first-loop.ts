'use client'

import { useRef } from 'react'
import { useLocale } from 'next-intl'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAssistantFeatureEnabled, useAssistantRuntime } from '../runtime'
import { firstLoopClient } from '../sdk/first-loop-client'
import {
  firstLoopCommand,
  acceptFirstLoopReceipt,
  type FirstLoopScope,
  type FirstLoopCommandKind,
} from '../lib/first-loop-command'
import type { FirstLoopState } from '../types/first-loop.schemas'
import { useSalesAssistantUserId } from './use-sales-assistant-me'
import { useFirstLoopCommandOutcome } from './use-first-loop-command-outcome'

function pollInterval(state?: FirstLoopState): number | false {
  if (!state) return 10000
  if (
    state.latest_turn &&
    ['accepted', 'running', 'unknown'].includes(state.latest_turn.status)
  )
    return 3000
  if (['working', 'reviewing'].includes(state.phase)) return 3000
  if (state.phase === 'intake' && state.latest_turn?.status === 'completed')
    return 5000
  if (state.work && state.work.projection.status !== 'fresh') return 5000
  return 10000 // Completed work can still receive new canonical scheduled messages.
}

interface CommandInput {
  kind: FirstLoopCommandKind
  text?: string
  revision?: number
  scope: FirstLoopScope
}
function useCommandMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ kind, text, revision, scope }: CommandInput) =>
      firstLoopCommand(scope, kind, text, revision),
    retry: false,
    onSuccess: (receipt, { kind, scope }) => {
      client.setQueryData<FirstLoopState>(scope.queryKey, previous =>
        acceptFirstLoopReceipt(previous, receipt, kind)
      )
      void client.invalidateQueries({ queryKey: scope.queryKey })
    },
  })
}
function canStart(scope: FirstLoopScope) {
  return (
    Boolean(scope.state && scope.businessId && scope.userId) &&
    !['accepted', 'running', 'unknown'].includes(
      scope.state?.latest_turn?.status ?? ''
    )
  )
}
function useCommands(scope: FirstLoopScope) {
  const client = useQueryClient()
  const locks = useRef(new Set<string>())
  const key = JSON.stringify(scope.queryKey)
  const mutation = useCommandMutation()
  const outcome = useFirstLoopCommandOutcome(scope)
  async function execute(
    kind: FirstLoopCommandKind,
    text?: string,
    revision?: number
  ): Promise<boolean> {
    if (
      locks.current.has(key) ||
      !canStart(scope) ||
      outcome.mutationError === 'uncertain'
    )
      return false
    locks.current.add(key)
    outcome.reset()
    try {
      await mutation.mutateAsync({ kind, text, revision, scope })
      return true
    } catch (failure) {
      void client.invalidateQueries({ queryKey: scope.queryKey })
      return await outcome.capture(failure, scope, kind)
    } finally {
      locks.current.delete(key)
    }
  }
  return {
    execute,
    isPending:
      mutation.isPending &&
      JSON.stringify(mutation.variables?.scope.queryKey) === key,
    mutationError: outcome.mutationError,
  }
}

export function useFirstLoop(businessId: string | null) {
  const locale = useLocale()
  const userId = useSalesAssistantUserId()
  const enabled = useAssistantFeatureEnabled()
  const runtime = useAssistantRuntime()
  const queryKey = [
    'meta-assistant',
    'first-loop',
    userId,
    businessId,
    locale,
  ] as const
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => firstLoopClient.state(businessId!, locale, signal),
    enabled: enabled && runtime.id === 'meta' && !!businessId && !!userId,
    staleTime: 0,
    retry: 1,
    refetchInterval: value => pollInterval(value.state.data),
  })
  const commands = useCommands({
    userId,
    businessId,
    locale: query.data?.response_locale ?? locale,
    state: query.data,
    queryKey,
  })
  const state = query.data
  const turnBusy =
    !!state?.latest_turn &&
    ['accepted', 'running', 'unknown'].includes(state.latest_turn.status)
  const refresh = () => query.refetch().then(result => !result.isError)
  return {
    state,
    isLoading: query.isPending,
    isError: query.isError,
    busy:
      turnBusy || commands.isPending || commands.mutationError === 'uncertain',
    isRefreshing: query.isFetching,
    mutationError: commands.mutationError,
    uncertain: commands.mutationError === 'uncertain',
    refresh,
    send: (text: string) => commands.execute('message', text),
    confirm: () => commands.execute('kickoff'),
    feedback: (text: string, revision: number) =>
      commands.execute('feedback', text, revision),
  }
}
