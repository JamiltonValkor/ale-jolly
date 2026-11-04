import { z } from 'zod'
import {
  agentBudgetSchema,
  agentBudgetUpdateSchema,
} from '@/shared/contracts/agent-budget'

/**
 * Contrato v1 de ORQA del usuario (ola `saleads-orqa-cliente-mvp-v1`): fotos
 * del cerebro (OSB-010), aprobaciones (OSB-013), compartir lecciones y buzón
 * admin (OSB-015) y catálogo de habilidades (OSB-016).
 *
 * Fuente: `sa-assistant-service/src/contracts/v1.ts` y
 * `src/brain-hub/contracts.ts`, con sus JSON Schema vendorizados en
 * `../contracts/v1/` (rama `feat/orqa-cliente-mvp`, `cef26fd`). El test de
 * paridad de `sales-assistant.schemas.test.ts` los cubre.
 */

const datetime = z.iso.datetime({ offset: true })
const itemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
const industrySlug = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)

// ---- Fotos del cerebro (OSB-010) --------------------------------------------

export const BRAIN_NODE_FAMILIES = [
  'identity',
  'offer',
  'market',
  'competition',
  'channels',
  'strategy',
  'operations',
  'learning',
  'meta',
  'learned',
  'other',
] as const
export const BRAIN_NODE_STATES = [
  'observed',
  'proposed',
  'validated',
  'superseded',
] as const

export const brainNodeSchema = z
  .object({
    id: z.string().max(64),
    type: z.string().max(64),
    family: z.enum(BRAIN_NODE_FAMILIES),
    label: z.string().max(200),
    summary: z.string().max(500),
    state: z.enum(BRAIN_NODE_STATES),
    provenance: z.string().max(40),
    mentions: z.number().int().min(0),
    created_at: z.string().nullable(),
  })
  .strict()

export const brainEdgeSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    type: z.string().max(64),
    fact: z.string().max(300),
    provenance: z.string().max(40),
    valid_at: z.string().nullable(),
    invalid_at: z.string().nullable(),
  })
  .strict()

export const brainBusinessGraphSchema = z
  .object({
    business_id: z.uuid(),
    nodes: z.array(brainNodeSchema).max(500),
    edges: z.array(brainEdgeSchema).max(2000),
    stats: z
      .object({ nodes: z.number().int(), edges: z.number().int() })
      .strict(),
  })
  .strict()

const brainSnapshotSummarySchema = z
  .object({
    version: z.number().int().min(1),
    created_at: datetime,
    generated_at: datetime.nullable(),
    node_count: z.number().int().min(0),
    edge_count: z.number().int().min(0),
  })
  .strict()

export const brainSnapshotsSchema = z
  .object({ business_id: z.uuid(), items: z.array(brainSnapshotSummarySchema) })
  .strict()

export const brainSnapshotSchema = brainSnapshotSummarySchema
  .extend({ graph: brainBusinessGraphSchema })
  .strict()

// ---- Aprobaciones de instalación (OSB-013) ----------------------------------

export const APPROVAL_KINDS = [
  'install_skill',
  'uninstall_skill',
  'install_mcp',
  // Agente de marketing (MLB-013): acciones de gasto, aprobadas con un código de un solo uso.
  'launch_plan',
  'pause_campaign',
  'change_budget',
  'resume_campaign',
  // API agencial (AAB-012, D21): encender lo que el agente publicó en pausa; un botón, sin código.
  'activate_agent_publication',
] as const
export const SPEND_APPROVAL_KINDS = [
  'launch_plan',
  'pause_campaign',
  'change_budget',
  'resume_campaign',
] as const
export type SpendApprovalKind = (typeof SPEND_APPROVAL_KINDS)[number]

const moneySchema = z
  .object({
    amount: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()

/** Lo que el dueño aprueba en una acción de gasto (MLB-013); el servicio lo arma desde el plan o la campaña. */
export const approvalDetailsSchema = z
  .object({
    action: z.enum(SPEND_APPROVAL_KINDS),
    summary: z.string().max(300),
    monthly_budget: moneySchema.nullable(),
    campaign_ids: z.array(itemId).max(50).nullable(),
    reason: z.string().max(300).nullable(),
    code_required: z.literal(true),
    result: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()])
      )
      .nullable(),
  })
  .strict()

const resultSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .nullable()

/** Montos que pueden ser cero (gasto a la fecha, proyectado): misma forma que `moneySchema`. */
const moneyAtLeastZeroSchema = z
  .object({
    amount: z.number().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()

/**
 * Lo que el dueño aprueba al encender una publicación del agente (AAB-012,
 * D21, `critico-final.md` §3). Una publicación = una campaña (C-7). Montos en
 * unidades mayores. Todo sale de lecturas del servicio, nunca texto del agente.
 * Fuente: `sa-assistant-service/src/contracts/v1.ts` (`cb960f5e`, MR !62).
 */
export const agentActivationDetailsSchema = z
  .object({
    action: z.literal('activate_agent_publication'),
    summary: z.string().max(300),
    publication_id: z.uuid(),
    campaign: z
      .object({
        campaign_id: z.uuid(),
        name: z.string().max(120),
        objective: z.string().max(64).nullable(),
        daily_budget: moneySchema.nullable(),
        lifetime_budget: moneySchema.nullable(),
      })
      .strict(),
    ad_sets: z
      .array(
        z
          .object({
            ad_set_id: z.uuid(),
            name: z.string().max(120),
            daily_budget: moneySchema.nullable(),
            audience_summary: z.string().max(200).nullable(),
          })
          .strict()
      )
      .max(50),
    ads_count: z.number().int().min(0),
    pieces: z
      .array(
        z
          .object({
            thumbnail_url: z.url({ protocol: /^https$/ }).nullable(),
            format: z.enum(['image', 'video']).nullable(),
          })
          .strict()
      )
      .max(20),
    bets: z
      .array(
        z
          .object({
            bet_id: z.uuid(),
            label: z.string().max(120).nullable(),
            hypothesis: z.string().max(300).nullable(),
          })
          .strict()
      )
      .max(20),
    skill_ref: z
      .object({
        skill_id: z.string().max(128),
        skill_version: z.string().max(64).nullable(),
      })
      .strict()
      .nullable(),
    budget: z
      .object({
        monthly: moneySchema.nullable(),
        spent_to_date: moneyAtLeastZeroSchema,
        projected_with_activation: moneyAtLeastZeroSchema,
        exceeds: z.boolean(),
        proposed_monthly: moneySchema.nullable(),
      })
      .strict(),
    code_required: z.literal(false),
    result: resultSchema,
  })
  .strict()

export const APPROVAL_STATUSES = [
  'pending',
  'executing',
  'executed',
  'failed',
  'rejected',
  'expired',
  'stale',
] as const

export const approvalSchema = z
  .object({
    id: z.uuid(),
    business_id: z.uuid(),
    kind: z.enum(APPROVAL_KINDS),
    status: z.enum(APPROVAL_STATUSES),
    item: z
      .object({
        id: itemId,
        name: z.string().trim().min(1).max(120),
        version: z.string().trim().min(1).max(64),
        summary: z.string().trim().max(500).nullable(),
      })
      .strict(),
    // Mismo constructor que el servicio (`z.union`): gasto (con código) o encendido del agente (sin código).
    details: z
      .union([approvalDetailsSchema, agentActivationDetailsSchema])
      .optional(),
    expires_at: datetime,
    created_at: datetime,
    decided_at: datetime.nullable(),
  })
  .strict()

/** `POST /approvals/:id/code`: código simulado (D8); la web lo muestra como si llegara por mensaje. */
export const approvalCodeResponseSchema = z
  .object({
    expires_at: datetime,
    attempts_left: z.number().int().min(0).max(3),
    delivery: z.literal('simulated'),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict()
export const approvalDecisionRequestSchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict()

// ---- Tipo de negocio (MLB-002 / MLF-001) ------------------------------------

export const BUSINESS_TYPES = [
  'physical_product',
  'service',
  'infoproduct',
] as const
export type BusinessType = (typeof BUSINESS_TYPES)[number]
export const businessProfileSchema = z
  .object({
    business_id: z.uuid(),
    business_type: z.enum(BUSINESS_TYPES).nullable(),
    needs_choice: z.boolean(),
    source: z.enum(['bi', 'owner']).nullable(),
    updated_at: datetime.nullable(),
  })
  .strict()
export const businessProfileUpdateSchema = z
  .object({ business_type: z.enum(BUSINESS_TYPES) })
  .strict()

// ---- Mi cerebro v2: foto, comparación y feedback (MLB-014 / MLF-002/003) ----

export const BRAIN_V2_FAMILIES = [
  'identity',
  'offer',
  'market',
  'competition',
  'channels',
  'strategy',
  'operations',
  'learning',
  'meta',
  'bet',
  'verdict',
  'learned',
  'other',
] as const
const optText = z.string().max(300).nullable()
/** Nodo v2 estricto (espejo del servicio): lo usa la comparación entre fotos. */
export const brainNodeV2Schema = brainNodeSchema
  .extend({
    family: z.enum(BRAIN_V2_FAMILIES),
    type_label: z.string().max(64),
    stage: z.string().max(40).nullable(),
    confidence: z.enum(['baja', 'media', 'alta']).nullable(),
    verification: z.string().max(40),
    valid_from: optText,
    learned_at: optText,
    superseded_by: z.string().max(64).nullable(),
    scope: optText,
    evidence_count: z.number().int().min(0).nullable(),
    outcome: z.string().max(20).nullable(),
  })
  .strict()
export const BRAIN_SECTIONS = [
  'my_business',
  'active_bets',
  'learned',
  'did_not_work',
  'your_corrections',
  'to_confirm',
  'history',
] as const
export type BrainSection = (typeof BRAIN_SECTIONS)[number]

/**
 * Foto v2 tolerante (MLF-002): campos desconocidos no rompen la vista y una
 * familia nueva cae a «otra». Se publica antes de que el back emita la v2.
 */
const tolerantNodeV2 = brainNodeSchema
  .extend({
    family: z.string().max(40),
    type_label: z.string().max(64).catch(''),
    stage: z.string().max(40).nullable().catch(null),
    confidence: z.enum(['baja', 'media', 'alta']).nullable().catch(null),
    verification: z.string().max(40).catch(''),
    valid_from: optText.catch(null),
    learned_at: optText.catch(null),
    superseded_by: z.string().max(64).nullable().catch(null),
    scope: optText.catch(null),
    evidence_count: z.number().int().min(0).nullable().catch(null),
    outcome: z.string().max(20).nullable().catch(null),
  })
  .loose()
const sectionIds = z.array(z.string().max(64)).max(500)
export const brainBusinessGraphV2Schema = z
  .object({
    business_id: z.uuid(),
    nodes: z.array(tolerantNodeV2).max(500),
    edges: z.array(brainEdgeSchema.loose()).max(2000),
    stats: z
      .object({ nodes: z.number().int(), edges: z.number().int() })
      .loose(),
    sections: z
      .object({
        my_business: sectionIds.catch([]),
        active_bets: sectionIds.catch([]),
        learned: sectionIds.catch([]),
        did_not_work: sectionIds.catch([]),
        your_corrections: sectionIds.catch([]),
        to_confirm: sectionIds.catch([]),
        history: sectionIds.catch([]),
      })
      .loose(),
  })
  .loose()
export const brainSnapshotV2Schema = brainSnapshotSummarySchema
  .extend({ graph: brainBusinessGraphV2Schema })
  .loose()
/** `?schema=2` puede responder v1 (servicio viejo) o v2: la vista usa lo que haya. */
export const brainSnapshotAnySchema = z.union([
  brainSnapshotSchema,
  brainSnapshotV2Schema,
])

export const brainSnapshotDiffSchema = z
  .object({
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    added: z.array(brainNodeV2Schema),
    removed: z.array(brainNodeV2Schema),
    modified: z.array(
      z
        .object({
          id: z.string().max(64),
          before: brainNodeV2Schema,
          after: brainNodeV2Schema,
        })
        .strict()
    ),
    counts: z
      .object({
        added: z.number().int(),
        removed: z.number().int(),
        modified: z.number().int(),
      })
      .strict(),
  })
  .strict()

export const BRAIN_FEEDBACK_ACTIONS = [
  'confirm',
  'correct',
  'no_longer_applies',
] as const
export type BrainFeedbackAction = (typeof BRAIN_FEEDBACK_ACTIONS)[number]
export const brainFeedbackRequestSchema = z
  .object({
    node_id: z.string().min(1).max(64),
    action: z.enum(BRAIN_FEEDBACK_ACTIONS),
    text: z.string().trim().max(1000).optional(),
  })
  .strict()
export const brainFeedbackResponseSchema = z
  .object({ id: z.uuid(), status: z.enum(['pending', 'delivered']) })
  .strict()

// ---- Catálogo, compartir lecciones y buzón (OSB-015/016) --------------------

export const catalogItemSchema = z
  .object({
    id: itemId,
    version: z.string(),
    kind: z.enum(['skill', 'mcp']),
    source: z.enum([
      'saleads_capability',
      'industry_playbook',
      'validated_lesson',
    ]),
    industry_slug: industrySlug.nullable(),
    name: z.string(),
    summary: z.string().nullable(),
    status: z.enum(['active', 'superseded', 'retired']),
  })
  .strict()

export const catalogViewSchema = z
  .object({
    industry_slug: industrySlug.nullable(),
    available: z.array(catalogItemSchema),
    installed: z.array(catalogItemSchema),
    retired_installed: z.array(catalogItemSchema),
  })
  .strict()

export const learningSharingSchema = z
  .object({ enabled: z.boolean(), notice_pending: z.boolean() })
  .strict()
/** Solo `true`: compartir ya no se apaga (D46/D47, MLB-017). */
export const learningSharingUpdateSchema = z
  .object({ enabled: z.literal(true) })
  .strict()

export const LESSON_STATUSES = [
  'received',
  'validated',
  'rejected',
  'published',
] as const

const ownerLessonSchema = z
  .object({
    id: z.uuid(),
    industry_slug: industrySlug,
    text: z.string(),
    status: z.enum(LESSON_STATUSES),
    created_at: datetime,
  })
  .strict()

export const ownerLessonsSchema = z
  .object({ lessons: z.array(ownerLessonSchema) })
  .strict()

const adminLessonSchema = ownerLessonSchema
  .extend({
    provenance: z.enum(['owner_said', 'owner_decided']),
    catalog_item_id: z.string().nullable(),
  })
  .strict()

export const adminLessonsSchema = z
  .object({ lessons: z.array(adminLessonSchema) })
  .strict()
export const adminCatalogSchema = z
  .object({ items: z.array(catalogItemSchema) })
  .strict()

export const publishRequestSchema = z
  .object({
    item_id: itemId,
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(500).nullable(),
  })
  .strict()
export const publishResponseSchema = z
  .object({ catalog_item_id: itemId, version: z.string() })
  .strict()

// ---- Presupuesto mensual aprobado del agente (AAB-012, D23, C-13) -----------
// El contrato vive en `shared/` (lo lee también la pestaña «Límites»); aquí se
// registra para la paridad con el JSON vendorizado.
export {
  agentBudgetSchema,
  agentBudgetUpdateSchema,
} from '@/shared/contracts/agent-budget'
export type {
  AgentBudget,
  AgentBudgetUpdate,
} from '@/shared/contracts/agent-budget'

/** Nombre del JSON vendorizado → schema (se suman a `SALES_ASSISTANT_CONTRACTS_V1`). */
export const ORQA_CONTRACTS_V1 = {
  'brain-snapshots-response': brainSnapshotsSchema,
  'brain-snapshot-response': brainSnapshotSchema,
  approval: approvalSchema,
  'catalog-view': catalogViewSchema,
  'learning-sharing': learningSharingSchema,
  'learning-sharing-update-request': learningSharingUpdateSchema,
  'owner-lessons-response': ownerLessonsSchema,
  'admin-lessons-response': adminLessonsSchema,
  'admin-catalog-response': adminCatalogSchema,
  'publish-request': publishRequestSchema,
  'publish-response': publishResponseSchema,
  'approval-code-response': approvalCodeResponseSchema,
  'approval-decision-request': approvalDecisionRequestSchema,
  'business-profile': businessProfileSchema,
  'business-profile-update-request': businessProfileUpdateSchema,
  'brain-snapshot-diff': brainSnapshotDiffSchema,
  'brain-feedback-request': brainFeedbackRequestSchema,
  'brain-feedback-response': brainFeedbackResponseSchema,
  'agent-budget': agentBudgetSchema,
  'agent-budget-update-request': agentBudgetUpdateSchema,
} as const

export type BrainNode = z.infer<typeof brainNodeSchema>
export type BrainEdge = z.infer<typeof brainEdgeSchema>
export type BrainBusinessGraph = z.infer<typeof brainBusinessGraphSchema>
export type BrainSnapshots = z.infer<typeof brainSnapshotsSchema>
export type BrainSnapshot = z.infer<typeof brainSnapshotSchema>
export type Approval = z.infer<typeof approvalSchema>
export type CatalogItem = z.infer<typeof catalogItemSchema>
export type CatalogView = z.infer<typeof catalogViewSchema>
export type LearningSharing = z.infer<typeof learningSharingSchema>
export type OwnerLessons = z.infer<typeof ownerLessonsSchema>
export type AdminLessons = z.infer<typeof adminLessonsSchema>
export type AdminLesson = AdminLessons['lessons'][number]
export type AdminCatalog = z.infer<typeof adminCatalogSchema>
export type PublishRequest = z.infer<typeof publishRequestSchema>
export type PublishResponse = z.infer<typeof publishResponseSchema>
export type ApprovalDetails = z.infer<typeof approvalDetailsSchema>
export type AgentActivationDetails = z.infer<
  typeof agentActivationDetailsSchema
>
export type ApprovalCodeResponse = z.infer<typeof approvalCodeResponseSchema>
export type BusinessProfile = z.infer<typeof businessProfileSchema>
export type BrainNodeV2 = z.infer<typeof brainNodeV2Schema>
export type BrainBusinessGraphV2 = z.infer<typeof brainBusinessGraphV2Schema>
export type BrainSnapshotV2 = z.infer<typeof brainSnapshotV2Schema>
export type BrainSnapshotAny = z.infer<typeof brainSnapshotAnySchema>
export type BrainSnapshotDiff = z.infer<typeof brainSnapshotDiffSchema>
export type BrainFeedbackResponse = z.infer<typeof brainFeedbackResponseSchema>
