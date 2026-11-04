'use client'

import { useMemo, useState } from 'react'
import { MetaUiScope } from '@/shared/meta-ui'
import { useBusinessStore } from '@/store/use-business-store'
import { useBrainFeedback } from '../../hooks/use-orqa-mutations'
import {
  useBrainDiff,
  useBrainSnapshots,
  useBrainSnapshotV2,
} from '../../hooks/use-orqa-queries'
import { useSalesAssistantMe } from '../../hooks/use-sales-assistant-me'
import { asV2 } from '../../lib/brain-v2'
import {
  brainStatus,
  changesStatus,
  defaultChangesRange,
  feedbackStatus,
} from '../../lib/meta-brain/container-state'
import { SalesAssistantClientError } from '../../sdk/sales-assistant-client'
import type { RenderCompanion } from '../meta-experience/types'
import { MetaBrainScene } from './meta-brain-scene'
import type {
  ChangesState,
  FeedbackInput,
  FeedbackState,
  MetaBrainMode,
} from './types'

interface Props {
  /** Fuerza el modo «asistente apagado» (por defecto lo dice `GET /me`). */
  stopped?: boolean
  initialMode?: MetaBrainMode
  renderCompanion?: RenderCompanion
  className?: string
}

const notFound = (error: unknown) =>
  error instanceof SalesAssistantClientError && error.code === 'NOT_FOUND'

function useChanges(
  businessId: string,
  items: ReturnType<typeof useBrainSnapshots>['data']
) {
  const list = useMemo(() => items?.items ?? [], [items])
  const fallback = useMemo(() => defaultChangesRange(list), [list])
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const from = range?.from ?? fallback.from
  const to = range?.to ?? fallback.to
  const diff = useBrainDiff(businessId, from, to)
  const changes: ChangesState = {
    from,
    to,
    diff: diff.data ?? null,
    status: changesStatus({
      enabled: from !== null && to !== null && from !== to,
      pending: diff.isPending,
      notFound: notFound(diff.error),
      error: diff.isError,
      ready: diff.isSuccess,
    }),
  }
  return {
    changes,
    setRange: (f: number, t: number) => setRange({ from: f, to: t }),
    retry: () => void diff.refetch(),
  }
}

function useFeedback(businessId: string, stopped: boolean) {
  const mutation = useBrainFeedback(businessId)
  const [settled, setSettled] = useState<Record<string, 'sent' | 'queued'>>({})
  const state: FeedbackState = {
    settled,
    nodeId: mutation.variables?.nodeId ?? null,
    status: feedbackStatus({
      pending: mutation.isPending,
      success: mutation.isSuccess,
      delivered: mutation.data?.status,
      error: mutation.isError,
      notFound: notFound(mutation.error),
      stopped,
    }),
  }
  const send = (input: FeedbackInput) =>
    mutation.mutate(input, {
      onSuccess: data => {
        const status = feedbackStatus({
          success: true,
          delivered: data.status,
          stopped,
        })
        if (status === 'sent' || status === 'queued')
          setSettled(current => ({ ...current, [input.nodeId]: status }))
      },
    })
  return { state, send }
}

function BusinessBrain({
  businessId,
  businessName,
  stopped,
  initialMode,
  renderCompanion,
  className,
}: { businessId: string; businessName: string; stopped: boolean } & Omit<
  Props,
  'stopped'
>) {
  const snapshots = useBrainSnapshots(businessId)
  const items = snapshots.data?.items ?? []
  const [chosen, setChosen] = useState<number | null>(null)
  const version = chosen ?? items[0]?.version ?? null
  const snapshot = useBrainSnapshotV2(businessId, version)
  const graph = useMemo(
    () => (snapshot.data ? asV2(snapshot.data.graph) : null),
    [snapshot.data]
  )
  const { changes, setRange, retry } = useChanges(businessId, snapshots.data)
  const feedback = useFeedback(businessId, stopped)
  const status = brainStatus({
    snapshotsPending: snapshots.isPending,
    snapshotsNotFound: notFound(snapshots.error),
    snapshotsError: snapshots.isError,
    noItems: snapshots.isSuccess && !items.length,
    snapshotPending: snapshot.isPending,
    snapshotError: snapshot.isError,
    nodes: graph?.nodes.length ?? 0,
  })
  const today = snapshot.data ? Date.parse(snapshot.data.created_at) : null
  return (
    <MetaBrainScene
      className={className}
      renderCompanion={renderCompanion}
      businessName={businessName}
      status={status}
      graph={graph}
      snapshots={items}
      version={version}
      onVersionChange={setChosen}
      stopped={stopped}
      onRetry={() => {
        void snapshots.refetch()
        if (version !== null) void snapshot.refetch()
      }}
      feedback={feedback.state}
      onFeedback={feedback.send}
      changes={changes}
      onChangesRange={setRange}
      onChangesRetry={retry}
      initialMode={initialMode}
      today={Number.isNaN(today) ? null : today}
    />
  )
}

/**
 * «Mi cerebro» del Meta Assistant (contenedor): negocio activo, fotos
 * guardadas, comparación y respuestas del dueño, por el BFF del runtime
 * (`useAssistantRuntime`). La vista es `MetaBrainScene`.
 */
export function MetaBrainView({
  stopped,
  initialMode,
  renderCompanion,
  className,
}: Props) {
  const business = useBusinessStore(state => state.selectedBusiness)
  const me = useSalesAssistantMe()
  const isStopped = stopped ?? me.data?.status === 'stopped'
  return (
    <MetaUiScope>
      {business ? (
        <BusinessBrain
          businessId={business.business_id}
          businessName={business.business_name ?? ''}
          stopped={isStopped}
          initialMode={initialMode}
          renderCompanion={renderCompanion}
          className={className}
        />
      ) : (
        <MetaBrainScene
          className={className}
          businessName=""
          status="noBusiness"
          graph={null}
          snapshots={[]}
          version={null}
          feedback={{ nodeId: null, status: 'idle' }}
          onFeedback={() => undefined}
          changes={{ from: null, to: null, status: 'idle', diff: null }}
        />
      )}
    </MetaUiScope>
  )
}
