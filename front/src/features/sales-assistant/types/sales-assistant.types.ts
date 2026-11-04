import type { z } from 'zod'
import type {
  SALES_ASSISTANT_AI_RESULTS,
  SALES_ASSISTANT_ERROR_CODES,
  SALES_ASSISTANT_STATUSES,
  SALES_ASSISTANT_STEPS,
  salesAssistantActivationSchema,
  salesAssistantAiRequestSchema,
  salesAssistantAiResponseSchema,
  salesAssistantErrorSchema,
  salesAssistantMeSchema,
  salesAssistantMessagesSchema,
  salesAssistantProvidersSchema,
  salesAssistantSessionSchema,
  salesAssistantStreamEventSchema,
} from './sales-assistant.schemas'

export type SalesAssistantStatus = (typeof SALES_ASSISTANT_STATUSES)[number]
export type SalesAssistantStep = (typeof SALES_ASSISTANT_STEPS)[number]
export type SalesAssistantMe = z.infer<typeof salesAssistantMeSchema>
export type SalesAssistantActivation = z.infer<
  typeof salesAssistantActivationSchema
>
export type SalesAssistantProvider = z.infer<
  typeof salesAssistantProvidersSchema
>[number]
export type SalesAssistantAiRequest = z.infer<
  typeof salesAssistantAiRequestSchema
>
export type SalesAssistantAiResult = (typeof SALES_ASSISTANT_AI_RESULTS)[number]
export type SalesAssistantAiResponse = z.infer<
  typeof salesAssistantAiResponseSchema
>
export type SalesAssistantStreamEvent = z.infer<
  typeof salesAssistantStreamEventSchema
>
export type SalesAssistantSession = z.infer<typeof salesAssistantSessionSchema>
export type SalesAssistantMessages = z.infer<
  typeof salesAssistantMessagesSchema
>
export type SalesAssistantMessage = SalesAssistantMessages['messages'][number]
export type SalesAssistantServiceErrorCode =
  (typeof SALES_ASSISTANT_ERROR_CODES)[number]
export type SalesAssistantErrorBody = z.infer<typeof salesAssistantErrorSchema>
