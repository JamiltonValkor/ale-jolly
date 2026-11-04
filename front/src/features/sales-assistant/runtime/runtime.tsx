'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { createAssistantQueryKeys, salesAssistantKeys } from '../lib/query-keys'
import * as classicClient from '../sdk/sales-assistant-client'
import * as classicOrqa from '../sdk/orqa-client'
import { streamSalesAssistantTurn } from '../sdk/sales-assistant-stream'
import {
  createRuntimeClients,
  robotDevicesClient,
} from '../sdk/runtime-clients'

export const META_ASSISTANT_FLAG = 'meta-assistant-enabled'

const CLASSIC = {
  id: 'legacy',
  bffPrefix: '/api/sales-assistant',
  dashboardPath: '/dashboard/assistant',
  queryNamespace: 'sales-assistant',
  storageNamespace: 'sales-assistant',
  managedAi: false,
  flagKey: 'sales-assistant-enabled',
  keys: salesAssistantKeys,
  client: classicClient,
  orqa: classicOrqa,
  streamTurn: streamSalesAssistantTurn,
  devices: robotDevicesClient(classicClient.requestJson),
} as const

function metaRuntime() {
  return {
    id: 'meta',
    bffPrefix: '/api/meta-assistant',
    dashboardPath: '/dashboard/meta-assistant',
    queryNamespace: 'meta-assistant',
    storageNamespace: 'meta-assistant',
    managedAi: true,
    flagKey: META_ASSISTANT_FLAG,
    keys: createAssistantQueryKeys('meta-assistant'),
    ...createRuntimeClients('/api/meta-assistant', true),
  } as const
}

export type AssistantRuntime = typeof CLASSIC | ReturnType<typeof metaRuntime>
const RuntimeContext = createContext<AssistantRuntime>(CLASSIC)

export function AssistantRuntimeProvider({
  runtime,
  children,
}: {
  runtime: 'meta' | 'legacy'
  children: ReactNode
}) {
  const value = useMemo(
    () => (runtime === 'meta' ? metaRuntime() : CLASSIC),
    [runtime]
  )
  return (
    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
  )
}

export function useAssistantRuntime(): AssistantRuntime {
  return useContext(RuntimeContext)
}

/** Meta Assistant es para todas las cuentas: solo el clásico sigue con bandera. */
export function useAssistantFeatureEnabled(): boolean {
  const { id, flagKey } = useAssistantRuntime()
  const flag = useFeatureFlag(flagKey)
  return id === 'meta' || flag
}
