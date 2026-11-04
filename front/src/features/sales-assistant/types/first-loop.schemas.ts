// GENERATED from ale-runtime src/first-loop/contracts.ts. Do not edit by hand.
// Regenerate: node scripts/sync-first-loop-contracts.mjs <canonical-contract-path>
import { z } from 'zod'

const Id = z.uuid()
const NativeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/)
const DateTime = z.iso.datetime({ offset: true })
export const ResponseLocaleV1 = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
export const FirstLoopProfileV1 = z.enum([
  'investigador',
  'estratega',
  'estructurador',
  'analista',
  'optimizador',
])
export const FirstLoopStageV1 = z.enum([
  'research',
  'strategy',
  'structure',
  'analysis',
  'optimization',
  'summary',
])
export const FirstLoopBriefV1 = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    offering: z.string().max(2000).nullable(),
    market: z.string().max(1000).nullable(),
    constraints: z.array(z.string().max(1000)).max(20),
    owner_message_ids: z.array(Id).min(1).max(100),
    owner_quotes: z
      .array(
        z
          .object({ client_message_id: Id, quote: z.string().min(1).max(4000) })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict()
export const FirstLoopMessageRequestV1 = z
  .object({
    flow_id: Id,
    client_message_id: Id,
    text: z.string().trim().min(1).max(8000),
    response_locale: ResponseLocaleV1,
  })
  .strict()
export const FirstLoopKickoffRequestV1 = z
  .object({ flow_id: Id, brief_revision: z.number().int().positive() })
  .strict()
export const FirstLoopFeedbackRequestV1 = z
  .object({
    artifact_revision: z.number().int().positive(),
    client_message_id: Id,
    text: z.string().trim().min(1).max(8000),
    response_locale: ResponseLocaleV1,
  })
  .strict()
export const FirstLoopTurnV1 = z
  .object({
    client_message_id: Id,
    run_id: NativeId.nullable(),
    status: z.enum(['accepted', 'running', 'completed', 'failed', 'unknown']),
  })
  .strict()
export const FirstLoopAcceptedV1 = z
  .object({
    flow_id: Id,
    session_id: NativeId,
    work_id: Id.nullable(),
    turn: FirstLoopTurnV1,
  })
  .strict()
export const FirstLoopArtifactV1 = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    task_id: NativeId,
    stage: FirstLoopStageV1,
    revision: z.number().int().positive(),
    title: z.string().max(200),
    content_type: z.enum(['text/markdown', 'text/plain', 'application/json']),
    content: z.string().max(131072),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(262144),
    response_locale: ResponseLocaleV1,
    sources: z
      .array(
        z
          .object({
            title: z.string().max(300),
            url: z.url().refine(v => /^https?:\/\//.test(v)),
          })
          .strict()
      )
      .max(100),
  })
  .strict()
export const FirstLoopTaskV1 = z
  .object({
    id: NativeId,
    profile: FirstLoopProfileV1,
    stage: FirstLoopStageV1,
    revision: z.number().int().positive(),
    title: z.string().max(200),
    status: z.enum([
      'queued',
      'running',
      'awaiting_review',
      'completed',
      'blocked',
      'failed',
      'cancelled',
      'unknown',
    ]),
    native_status: z.string().max(50),
    parents: z.array(NativeId).max(100),
    run_refs: z.array(NativeId).max(100),
    execution_verified: z.boolean(),
    updated_at: DateTime.nullable(),
  })
  .strict()
export const FirstLoopWorkV1 = z
  .object({
    schema_version: z.literal('first-loop/1'),
    work_id: Id,
    business_id: Id,
    flow_id: Id,
    brief_revision: z.number().int().positive(),
    revision: z.number().int().positive(),
    response_locale: ResponseLocaleV1,
    status: z.enum([
      'waiting_for_tasks',
      'running',
      'awaiting_feedback',
      'reviewing',
      'completed',
      'blocked',
      'unknown',
    ]),
    projection: z
      .object({
        status: z.enum(['missing', 'fresh', 'stale', 'invalid', 'unavailable']),
        observed_at: DateTime.nullable(),
        cursor: z.string().max(150).nullable(),
      })
      .strict(),
    tasks: z.array(FirstLoopTaskV1).max(100),
    artifacts: z.array(FirstLoopArtifactV1).max(100),
    feedback_count: z.number().int().nonnegative(),
    delivery: z.enum(['pending', 'available', 'unavailable']),
  })
  .strict()
export const FirstLoopStateV1 = z
  .object({
    schema_version: z.literal('first-loop/1'),
    business_id: Id,
    flow_id: Id,
    session_id: NativeId,
    response_locale: ResponseLocaleV1,
    phase: z.enum([
      'intake',
      'confirm_brief',
      'working',
      'awaiting_feedback',
      'reviewing',
      'complete',
      'blocked',
    ]),
    brief_revision: z.number().int().nonnegative(),
    brief: FirstLoopBriefV1.nullable(),
    missing_fields: z.array(z.string().max(100)).max(20),
    active_work_id: Id.nullable(),
    latest_turn: FirstLoopTurnV1.nullable(),
    messages: z
      .array(
        z
          .object({
            id: z.string().max(200),
            role: z.enum(['user', 'assistant']),
            text: z.string(),
            created_at: DateTime.nullable(),
          })
          .strict()
      )
      .max(200),
    work: FirstLoopWorkV1.nullable(),
  })
  .strict()
export const FirstLoopProjectionV1 = z
  .object({
    schema_version: z.literal('first-loop-projection/1'),
    observed_at: DateTime,
    generation: z.string().regex(/^[a-f0-9]{64}$/),
    briefs: z
      .array(
        z
          .object({
            flow_id: Id,
            business_id: Id,
            brief_revision: z.number().int().positive(),
            brief: FirstLoopBriefV1,
            missing_fields: z.array(z.string().max(100)).max(20),
          })
          .strict()
      )
      .max(100),
    works: z
      .array(
        z
          .object({
            work_id: Id,
            business_id: Id,
            tasks: z.array(FirstLoopTaskV1).max(100),
            artifacts: z.array(FirstLoopArtifactV1).max(100),
          })
          .strict()
      )
      .max(100),
  })
  .strict()
export type FirstLoopState = z.infer<typeof FirstLoopStateV1>
export type FirstLoopWork = z.infer<typeof FirstLoopWorkV1>
export type FirstLoopBrief = z.infer<typeof FirstLoopBriefV1>

export type FirstLoopAccepted = z.infer<typeof FirstLoopAcceptedV1>
export type FirstLoopArtifact = z.infer<typeof FirstLoopArtifactV1>
export type FirstLoopTask = z.infer<typeof FirstLoopTaskV1>
export type FirstLoopMessageRequest = z.infer<typeof FirstLoopMessageRequestV1>
export type FirstLoopFeedbackRequest = z.infer<
  typeof FirstLoopFeedbackRequestV1
>
