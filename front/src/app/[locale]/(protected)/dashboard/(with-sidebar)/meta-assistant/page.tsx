import { AssistantRuntimeProvider } from '@/features/sales-assistant'
import { MetaAssistantExperience } from './meta-assistant-experience'

export default function MetaAssistantPage() {
  return (
    <AssistantRuntimeProvider runtime="meta">
      <MetaAssistantExperience />
    </AssistantRuntimeProvider>
  )
}
