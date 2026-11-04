import {z} from 'zod';

/** Additive MCL contracts. These are data envelopes, never authority supplied by a model. */
const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
const Owner = z.string().min(1).max(200);
const Instant = z.iso.datetime({offset: true});
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ResponseLocaleV1 = z.string().min(2).max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
export const SpecialistRoleV1 = z.enum(['investigador', 'estratega', 'estructurador', 'analista', 'optimizador', 'disenador_landings']);
export const ActorRoleV1 = z.enum(['ale', ...SpecialistRoleV1.options, 'curador']);
export const KnowledgeScopeV1 = z.enum(['business', 'specialist', 'team']);
export const ValidationStateV1 = z.enum(['proposed', 'confirmed', 'pending_conflict', 'rejected', 'superseded']);
const Binding = {owner_id: Owner, business_id: z.uuid()};
const SourceRefs = z.array(Id).min(1).max(20);
const Validity = {valid_from: Instant, valid_until: Instant.nullable()};
const Primitive = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);

export const TrustedContextV1 = z.object({
  schema_version: z.literal('trusted-context/1'), ...Binding,
  session_id: Id, actor_role: ActorRoleV1,
  native_task_id: Id.nullable(), native_run_id: Id.nullable(),
  response_locale: ResponseLocaleV1, locale_revision: z.number().int().positive(),
  capabilities: z.array(Id).max(100), mandate_id: Id.nullable(), pending_context: z.boolean(),
}).strict();

const sourceAuthors = {
  owner_message: 'owner', specialist_result: 'specialist', cron_result: 'cron',
  api_observation: 'api', server_instruction: 'server', operator_canary: 'operator',
} as const;
export const SourceEventV1 = z.object({
  schema_version: z.literal('source-event/1'), event_id: Id, ...Binding,
  source_kind: z.enum(['owner_message', 'specialist_result', 'cron_result', 'api_observation', 'server_instruction', 'operator_canary']),
  source_id: Id, source_version: Id,
  author: z.object({kind: z.enum(['owner', 'specialist', 'cron', 'operator', 'server', 'api']), id: Id}).strict(),
  extractor_id: Id.nullable(), occurred_at: Instant, recorded_at: Instant,
  content: z.string().min(1).max(24000), content_sha256: Hash,
  refs: z.array(z.string().min(1).max(2048)).max(30),
  purpose: z.enum(['business_work', 'owner_preference', 'technical_canary']),
  native_task_id: Id.nullable(), native_run_id: Id.nullable(),
}).strict().superRefine((value, ctx) => {
  if (sourceAuthors[value.source_kind] !== value.author.kind) ctx.addIssue({code: 'custom', path: ['author'], message: 'source_author_mismatch'});
  if (value.source_kind === 'operator_canary' && value.purpose !== 'technical_canary') ctx.addIssue({code: 'custom', path: ['purpose'], message: 'operator_source_is_technical'});
});

export const KnowledgeCandidateV1 = z.object({
  schema_version: z.literal('knowledge-candidate/1'), candidate_id: Id, ...Binding,
  entity_type: z.string().regex(/^[A-Z][A-Za-z]{1,63}$/), content: z.string().min(1).max(8000),
  attributes: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), Primitive),
  source_event_ids: SourceRefs, scope: KnowledgeScopeV1, specialist_role: SpecialistRoleV1.nullable(),
  extractor_id: Id, epistemic: z.enum(['declared', 'observed', 'inferred']),
  validation_state: ValidationStateV1, ...Validity,
  supersedes_id: Id.nullable(), contradicts_id: Id.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'specialist' && value.specialist_role === null) ctx.addIssue({code: 'custom', path: ['specialist_role'], message: 'specialist_role_required'});
  if (value.scope !== 'specialist' && value.specialist_role !== null) ctx.addIssue({code: 'custom', path: ['specialist_role'], message: 'role_only_for_specialist_scope'});
  if (value.epistemic === 'inferred' && value.validation_state === 'confirmed') ctx.addIssue({code: 'custom', path: ['validation_state'], message: 'inference_is_not_confirmed_fact'});
  if (value.valid_until !== null && Date.parse(value.valid_until) <= Date.parse(value.valid_from)) ctx.addIssue({code: 'custom', path: ['valid_until'], message: 'invalid_validity_window'});
});

export const SpecialistExperienceV1 = z.object({
  schema_version: z.literal('specialist-experience/1'), experience_id: Id, ...Binding,
  specialist_role: SpecialistRoleV1, task_id: Id, run_id: Id,
  method: z.string().min(1).max(2000), observed_result: z.string().min(1).max(4000),
  correction: z.string().max(2000), lesson: z.string().min(1).max(2000),
  applicability: z.string().min(1).max(2000), source_event_ids: SourceRefs,
  confidence: z.enum(['proposed', 'supported', 'validated']), ...Validity,
  shared_summary: z.string().min(1).max(2000).nullable(),
}).strict();

export const CurationBatchV1 = z.object({
  schema_version: z.literal('curation-batch/1'), batch_id: Id, ...Binding,
  source_event_ids: SourceRefs, cursor: Id,
  state: z.enum(['pending', 'dispatched', 'running', 'committed', 'discarded', 'failed']),
  native_task_id: Id.nullable(), native_run_id: Id.nullable(), idempotency_key: Id,
  committed_ids: z.array(Id).max(100), discarded_reason: z.string().max(500).nullable(),
  error_code: Id.nullable(), updated_at: Instant,
}).strict();

export const GoalStateV1 = z.object({
  schema_version: z.literal('goal-state/1'), goal_id: Id, ...Binding,
  origin: z.enum(['assistant_proposed', 'owner_confirmed']),
  mandate: z.string().min(1).max(8000), source_event_ids: SourceRefs,
  native_task_ids: z.array(Id).max(100),
  state: z.enum(['intake', 'active', 'waiting', 'blocked', 'completed', 'cancelled']),
  blockers: z.array(z.string().min(1).max(500)).max(20),
  next_condition: z.string().max(2000).nullable(), next_review_at: Instant.nullable(),
  result_summary: z.string().max(4000).nullable(), revision: z.number().int().positive(), updated_at: Instant,
}).strict();

/** Effective injected text is capped separately; overlarge packs must be explicitly truncated. */
export const CONTEXT_PACK_MAX_CHARS = 8000;
export const DELIVERY_ACK_WINDOW_SECONDS = 120;
export const ContextPackV1 = z.object({
  schema_version: z.literal('context-pack/1'), pack_id: Id, ...Binding,
  actor_role: ActorRoleV1, goal: GoalStateV1.nullable(),
  knowledge: z.array(KnowledgeCandidateV1).max(20), experiences: z.array(SpecialistExperienceV1).max(3),
  refs: z.array(Id).max(100), versions: z.record(Id, z.number().int().positive()),
  pending: z.array(z.string().max(500)).max(10),
  text: z.string().max(CONTEXT_PACK_MAX_CHARS), truncated: z.boolean(), generated_at: Instant,
}).strict().superRefine((value, ctx) => {
  for (const entry of [...value.knowledge, ...value.experiences, ...(value.goal ? [value.goal] : [])]) {
    if (entry.owner_id !== value.owner_id || entry.business_id !== value.business_id) ctx.addIssue({code: 'custom', message: 'cross_business_context'});
  }
  for (const entry of value.experiences) {
    if (value.actor_role !== entry.specialist_role) ctx.addIssue({code: 'custom', message: 'private_experience_role_mismatch'});
  }
});

export const NotificationV1 = z.object({
  schema_version: z.literal('notification/1'), notification_id: Id, ...Binding,
  session_id: Id, source_id: Id, execution_id: Id, source_version: Id,
  source_kind: z.enum(['cron_result', 'goal_result']),
  text: z.string().trim().min(1).max(16000), response_locale: ResponseLocaleV1,
  terminal_state: z.enum(['completed', 'partial']), limitations: z.array(z.string().max(500)).max(10),
  created_at: Instant,
}).strict();

export const DeliveryReceiptV1 = z.object({
  schema_version: z.literal('delivery-receipt/1'), receipt_id: Id, notification_id: Id, ...Binding,
  destination: z.enum(['home', 'saleads']), destination_version: Id,
  attempt_id: Id, state: z.enum(['accepted', 'delivered', 'failed', 'unknown']),
  fallback: z.boolean(), evidence_ref: z.string().max(2048).nullable(),
  reconcile_by: Instant.nullable(), updated_at: Instant,
}).strict();

/** Browser projection deliberately omits native roles, prompts and memory artifacts. */
export const ConversationEventV1 = z.object({
  schema_version: z.literal('conversation-event/1'), event_id: Id, cursor: Id,
  business_id: z.uuid(), session_id: Id, message_id: Id,
  role: z.enum(['user', 'assistant']), text: z.string().min(1).max(16000),
  created_at: Instant, source: z.enum(['conversation', 'scheduled']), dedupe_key: Id,
}).strict();

export const CONTINUOUS_CONTRACTS = {
  'trusted-context': TrustedContextV1, 'source-event': SourceEventV1,
  'knowledge-candidate': KnowledgeCandidateV1, 'specialist-experience': SpecialistExperienceV1,
  'curation-batch': CurationBatchV1, 'context-pack': ContextPackV1, 'goal-state': GoalStateV1,
  notification: NotificationV1, 'delivery-receipt': DeliveryReceiptV1, 'conversation-event': ConversationEventV1,
} as const;
export const CONTINUOUS_CONTRACTS_DIR = 'contracts/continuous-loop/v1';
/** Native adapters consume the same role catalog without duplicating the enum. */
export function renderContinuousRoleCatalog(): string {
  return `${JSON.stringify({schema_version: 'actor-role-catalog/1',
    specialist_roles: SpecialistRoleV1.options, actor_roles: ActorRoleV1.options}, null, 2)}\n`;
}
export function renderContinuousContracts(): Record<string, string> {
  return Object.fromEntries(Object.entries(CONTINUOUS_CONTRACTS).map(([name, schema]) => [
    `${name}.schema.json`, `${JSON.stringify({
      $id: `https://saleads.ai/contracts/continuous-loop/v1/${name}.schema.json`,
      ...z.toJSONSchema(schema, {target: 'draft-2020-12'}),
    }, null, 2)}\n`,
  ]));
}

export type TrustedContextV1 = z.infer<typeof TrustedContextV1>;
export type SourceEventV1 = z.infer<typeof SourceEventV1>;
export type KnowledgeCandidateV1 = z.infer<typeof KnowledgeCandidateV1>;
export type SpecialistExperienceV1 = z.infer<typeof SpecialistExperienceV1>;
export type CurationBatchV1 = z.infer<typeof CurationBatchV1>;
export type ContextPackV1 = z.infer<typeof ContextPackV1>;
export type GoalStateV1 = z.infer<typeof GoalStateV1>;
export type NotificationV1 = z.infer<typeof NotificationV1>;
export type DeliveryReceiptV1 = z.infer<typeof DeliveryReceiptV1>;
export type ConversationEventV1 = z.infer<typeof ConversationEventV1>;
