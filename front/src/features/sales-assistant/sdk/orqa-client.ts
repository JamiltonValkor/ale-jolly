import { z } from 'zod'
import {
  approvalCodeResponseSchema,
  brainFeedbackResponseSchema,
  brainSnapshotAnySchema,
  brainSnapshotDiffSchema,
  businessProfileSchema,
  type ApprovalCodeResponse,
  type BrainFeedbackAction,
  type BrainFeedbackResponse,
  type BrainSnapshotAny,
  type BrainSnapshotDiff,
  type BusinessProfile,
  type BusinessType,
  adminCatalogSchema,
  adminLessonsSchema,
  approvalSchema,
  brainSnapshotSchema,
  brainSnapshotsSchema,
  catalogViewSchema,
  publishResponseSchema,
  type AdminCatalog,
  type AdminLessons,
  type Approval,
  type BrainSnapshot,
  type BrainSnapshots,
  type CatalogView,
  type PublishRequest,
  type PublishResponse,
} from '../types'
import { requestJson } from './sales-assistant-client'

/**
 * Cliente del navegador para ORQA del usuario (OSF-001…005), same-origin al
 * BFF. Las mutaciones que deciden algo llevan una `Idempotency-Key` que el
 * llamador genera una vez por decisión y reusa en los reintentos.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const okSchema = z.object({ ok: z.literal(true) }).strict()
const proposalSchema = z
  .object({ approval_id: z.uuid(), status: z.string() })
  .strict()
export type SkillProposal = z.infer<typeof proposalSchema>

const businessPath = (businessId: string) =>
  `/businesses/${encodeURIComponent(businessId)}`

export function fetchBrainSnapshots(
  businessId: string,
  limit: number,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<BrainSnapshots> {
  const path = `${businessPath(businessId)}/brain/snapshots?limit=${limit}`
  return request(path, brainSnapshotsSchema, { signal })
}

export function fetchBrainSnapshot(
  businessId: string,
  version: number,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<BrainSnapshot> {
  const path = `${businessPath(businessId)}/brain/snapshots/${version}`
  return request(path, brainSnapshotSchema, { signal })
}

export function fetchApproval(
  approvalId: string,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<Approval> {
  const path = `/approvals/${encodeURIComponent(approvalId)}`
  return request(path, approvalSchema, { signal })
}

export function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  idempotencyKey: string,
  code?: string,
  request: typeof requestJson = requestJson
): Promise<Approval> {
  const path = `/approvals/${encodeURIComponent(approvalId)}/${decision}`
  // Aprobar una acción de gasto lleva el código de un solo uso (MLF-006).
  return request(path, approvalSchema, {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey,
      ...(code ? JSON_HEADERS : {}),
    },
    ...(code ? { body: JSON.stringify({ code }) } : {}),
  })
}

/** Código simulado (D8): cada pedido invalida el anterior; máximo 3 por aprobación. */
export function requestApprovalCode(
  approvalId: string,
  request: typeof requestJson = requestJson
): Promise<ApprovalCodeResponse> {
  const path = `/approvals/${encodeURIComponent(approvalId)}/code`
  return request(path, approvalCodeResponseSchema, { method: 'POST' })
}

/** Foto en forma v2 (o v1 si el servicio aún no la tiene). */
export function fetchBrainSnapshotV2(
  businessId: string,
  version: number,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<BrainSnapshotAny> {
  const path = `${businessPath(businessId)}/brain/snapshots/${version}?schema=2`
  return request(path, brainSnapshotAnySchema, { signal })
}

export function fetchBrainDiff(
  businessId: string,
  from: number,
  to: number,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<BrainSnapshotDiff> {
  const path = `${businessPath(businessId)}/brain/snapshots/${to}/diff?from=${from}`
  return request(path, brainSnapshotDiffSchema, { signal })
}

export function sendBrainFeedback(
  businessId: string,
  input: { nodeId: string; action: BrainFeedbackAction; text?: string },
  idempotencyKey: string,
  request: typeof requestJson = requestJson
): Promise<BrainFeedbackResponse> {
  const path = `${businessPath(businessId)}/brain/feedback`
  return request(path, brainFeedbackResponseSchema, {
    method: 'POST',
    body: JSON.stringify({
      node_id: input.nodeId,
      action: input.action,
      ...(input.text ? { text: input.text } : {}),
    }),
    headers: { ...JSON_HEADERS, 'Idempotency-Key': idempotencyKey },
  })
}

export function fetchBusinessProfile(
  businessId: string,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<BusinessProfile> {
  return request(`${businessPath(businessId)}/profile`, businessProfileSchema, {
    signal,
  })
}

export function updateBusinessProfile(
  businessId: string,
  businessType: BusinessType,
  request: typeof requestJson = requestJson
): Promise<BusinessProfile> {
  return request(`${businessPath(businessId)}/profile`, businessProfileSchema, {
    method: 'PUT',
    body: JSON.stringify({ business_type: businessType }),
    headers: JSON_HEADERS,
  })
}

export function fetchSkillCatalog(
  businessId: string,
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<CatalogView> {
  const path = `${businessPath(businessId)}/skills/catalog`
  return request(path, catalogViewSchema, { signal })
}

export function proposeSkill(
  businessId: string,
  itemId: string,
  action: 'install' | 'uninstall',
  idempotencyKey: string,
  request: typeof requestJson = requestJson
): Promise<SkillProposal> {
  const path = `${businessPath(businessId)}/skills/${encodeURIComponent(itemId)}/${action}`
  return request(path, proposalSchema, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

export function fetchAdminLessons(
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<AdminLessons> {
  return request('/admin/brain-hub/lessons', adminLessonsSchema, {
    signal,
  })
}

export function reviewAdminLesson(
  lessonId: string,
  action: 'validate' | 'reject',
  request: typeof requestJson = requestJson
): Promise<{ ok: true }> {
  const path = `/admin/brain-hub/lessons/${encodeURIComponent(lessonId)}/${action}`
  return request(path, okSchema, { method: 'POST' })
}

export function publishAdminLesson(
  lessonId: string,
  input: PublishRequest,
  idempotencyKey: string,
  request: typeof requestJson = requestJson
): Promise<PublishResponse> {
  const path = `/admin/brain-hub/lessons/${encodeURIComponent(lessonId)}/publish`
  return request(path, publishResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { ...JSON_HEADERS, 'Idempotency-Key': idempotencyKey },
  })
}

export function fetchAdminCatalog(
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<AdminCatalog> {
  return request('/admin/brain-hub/catalog', adminCatalogSchema, { signal })
}

export function retireCatalogItem(
  itemId: string,
  request: typeof requestJson = requestJson
): Promise<{ ok: true }> {
  const path = `/admin/brain-hub/catalog/${encodeURIComponent(itemId)}/retire`
  return request(path, okSchema, { method: 'POST' })
}
