import {
  ApprovalView,
  AssistantRuntimeProvider,
} from '@/features/sales-assistant'
import { MetaUiScope } from '@/shared/meta-ui'

interface Props {
  params: Promise<{ approvalId: string }>
}

export default async function MetaAssistantApprovalPage({ params }: Props) {
  const { approvalId } = await params
  return (
    <AssistantRuntimeProvider runtime="meta">
      {/* Mismo lenguaje del chat nuevo que el resto de Meta Assistant. */}
      <MetaUiScope className="shrink-0 grow px-6 py-8">
        <ApprovalView approvalId={approvalId} />
      </MetaUiScope>
    </AssistantRuntimeProvider>
  )
}
