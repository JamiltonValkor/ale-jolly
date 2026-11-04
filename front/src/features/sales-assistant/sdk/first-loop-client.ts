import type { z } from 'zod'
import {
  FirstLoopAcceptedV1,
  FirstLoopFeedbackRequestV1,
  FirstLoopKickoffRequestV1,
  FirstLoopMessageRequestV1,
  FirstLoopStateV1,
  FirstLoopWorkV1,
  type FirstLoopFeedbackRequest,
  type FirstLoopMessageRequest,
} from '../types/first-loop.schemas'
import { requestJson } from './sales-assistant-client'

const META_BFF = '/api/meta-assistant'
const base = (businessId: string) =>
  `/businesses/${encodeURIComponent(businessId)}/first-loop`
const jsonHeaders = { 'Content-Type': 'application/json' }

export const firstLoopClient = {
  state: (businessId: string, locale: string, signal?: AbortSignal) =>
    requestJson(
      `${base(businessId)}?response_locale=${encodeURIComponent(locale)}`,
      FirstLoopStateV1.refine(
        state =>
          state.business_id === businessId &&
          (!state.work ||
            (state.work.business_id === businessId &&
              state.work.flow_id === state.flow_id &&
              state.work.work_id === state.active_work_id))
      ),
      { signal },
      META_BFF
    ),
  receipt: (
    businessId: string,
    flowId: string,
    messageId: string,
    signal?: AbortSignal
  ) =>
    requestJson(
      `${base(businessId)}/messages/${encodeURIComponent(messageId)}?flow_id=${encodeURIComponent(flowId)}`,
      FirstLoopAcceptedV1.refine(
        receipt =>
          receipt.flow_id === flowId &&
          receipt.turn.client_message_id === messageId
      ),
      { signal },
      META_BFF
    ),
  message: (
    businessId: string,
    input: FirstLoopMessageRequest,
    signal?: AbortSignal
  ) =>
    requestJson(
      `${base(businessId)}/messages`,
      FirstLoopAcceptedV1.refine(
        receipt =>
          receipt.flow_id === input.flow_id &&
          receipt.turn.client_message_id === input.client_message_id
      ),
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(FirstLoopMessageRequestV1.parse(input)),
        ...(signal ? { signal } : {}),
      },
      META_BFF
    ),
  kickoff: (
    businessId: string,
    input: z.infer<typeof FirstLoopKickoffRequestV1>,
    key: string
  ) =>
    requestJson(
      `${base(businessId)}/kickoff`,
      FirstLoopAcceptedV1.refine(receipt => receipt.flow_id === input.flow_id),
      {
        method: 'POST',
        headers: { ...jsonHeaders, 'Idempotency-Key': key },
        body: JSON.stringify(FirstLoopKickoffRequestV1.parse(input)),
      },
      META_BFF
    ),
  work: (businessId: string, workId: string, signal?: AbortSignal) =>
    requestJson(
      `${base(businessId)}/works/${encodeURIComponent(workId)}`,
      FirstLoopWorkV1.refine(
        work => work.business_id === businessId && work.work_id === workId
      ),
      { signal },
      META_BFF
    ),
  feedback: (
    businessId: string,
    workId: string,
    input: FirstLoopFeedbackRequest,
    key: string
  ) =>
    requestJson(
      `${base(businessId)}/works/${encodeURIComponent(workId)}/feedback`,
      FirstLoopAcceptedV1.refine(receipt => receipt.work_id === workId),
      {
        method: 'POST',
        headers: { ...jsonHeaders, 'Idempotency-Key': key },
        body: JSON.stringify(FirstLoopFeedbackRequestV1.parse(input)),
      },
      META_BFF
    ),
}
