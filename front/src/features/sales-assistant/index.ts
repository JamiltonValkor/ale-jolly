export {
  ApprovalView,
  BrainHubAdmin,
  BrainView,
  SkillsPanel,
  SalesAssistantAiForm,
  SalesAssistantChat,
  SalesAssistantPanel,
  SalesAssistantSidebarEntry,
  RobotCompanion,
} from './components'

export {
  useActivateSalesAssistantMutation,
  useConfigureSalesAssistantAiMutation,
  useCreateSalesAssistantSessionMutation,
  useDeleteSalesAssistantMutation,
  useMarkSalesAssistantSeen,
  useSalesAssistantChat,
  useSalesAssistantMe,
  useSalesAssistantMessages,
  useSalesAssistantProviders,
  useSalesAssistantReadyIndicator,
  useStartSalesAssistantMutation,
  useStopSalesAssistantMutation,
} from './hooks'

export { SALES_ASSISTANT_FLAG } from './lib/feature-flags'
export { MetaAssistantChat } from './components/first-loop/meta-assistant-chat'
export { AssistantRuntimeProvider, META_ASSISTANT_FLAG } from './runtime'
export { OneShotSecret } from './lib/one-shot-secret'
export { salesAssistantErrorKey } from './lib/error-messages'
export {
  SalesAssistantClientError,
  type SalesAssistantClientErrorCode,
} from './sdk/sales-assistant-client'
export { streamSalesAssistantTurn } from './sdk/sales-assistant-stream'

export type {
  SalesAssistantAiResult,
  SalesAssistantMe,
  SalesAssistantMessage,
  SalesAssistantProvider,
  SalesAssistantStatus,
  SalesAssistantStep,
  SalesAssistantStreamEvent,
} from './types'

// Meta Assistant con el lenguaje del chat nuevo (hackatón de Meta).
export {
  MetaActivityEmpty,
  MetaChatView,
  MetaExperience,
  MetaPreparingView,
  MetaShell,
  MetaStartView,
  MetaTabHelp,
  MetaTabPanel,
  MetaTabs,
  MetaTodayView,
  type CompanionLink,
  type CompanionMood,
  type CompanionRenderInput,
  type FaceRenderInput,
  type MetaChatMessage,
  type MetaReadySlots,
  type MetaTab,
  type PairingRenderInput,
  type ComposerRenderInput,
  type RenderCompanion,
  type RenderComposer,
  type RenderFace,
} from './components/meta-experience'
export {
  buildLoopModel,
  type LoopModel,
} from './lib/meta-experience/loop-model'
export { buildTeamModel } from './lib/meta-experience/team-model'
export { MetaBrainView } from './components/meta-brain/meta-brain-view'
