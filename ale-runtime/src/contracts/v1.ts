import {z} from 'zod';

/**
 * Contrato front ↔ servicio v1 (architecture.md, «Contrato front ↔ servicio»).
 * zod es la fuente: `contracts/one-click/v1/*.schema.json` se genera de aquí con
 * `npm run contracts:generate` y `npm test` falla si hay deriva.
 */

export const AssistantStatusV1 = z.enum(['none', 'activating', 'ready', 'stopped', 'failed', 'deleting']);
export const AssistantStepV1 = z.enum(['preparing_access', 'preparing_environment', 'installing_agent', 'configure_ai']);

/**
 * Zona horaria IANA (OCB-016): la del navegador del dueño. Válida si
 * `Intl.DateTimeFormat(undefined, {timeZone})` la acepta y mide ≤ 64; el
 * servicio guarda el nombre canónico que devuelve `resolvedOptions()`.
 */
export const IanaTimezoneV1 = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/).refine(isIanaTimezone);

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, {timeZone: value});
    return true;
  } catch {
    return false;
  }
}

export const AssistantStateV1 = z.object({
  status: AssistantStatusV1,
  step: AssistantStepV1.nullable(),
  slow: z.boolean(),
  session_id: z.string().min(1).max(200).nullable(),
  ai: z.object({
    configured: z.boolean(),
    provider: z.string().min(1).max(100).nullable(),
    model: z.string().min(1).max(200).nullable(),
  }).strict(),
  ready_since: z.iso.datetime({offset: true}).nullable(),
  /** IANA guardada (OCB-016); null = no la ha enviado el front (Hermes usa America/Bogota). */
  timezone: z.string().min(1).max(64).nullable(),
}).strict();

/** Cuerpo opcional de `POST /assistants/me/activation` (OCB-016). */
export const ActivationRequestV1 = z.object({timezone: IanaTimezoneV1.optional()}).strict();

/** `PUT /assistants/me/timezone` (OCB-016) → `AssistantStateV1`. */
export const TimezoneRequestV1 = z.object({timezone: IanaTimezoneV1}).strict();

export const ActivationResponseV1 = z.union([
  z.object({authorize_url: z.url({protocol: /^https?$/})}).strict(),
  AssistantStateV1,
]);

export const OAuthCallbackRequestV1 = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(16).max(512),
}).strict();

export const OAuthCallbackResponseV1 = z.union([
  z.object({ok: z.literal(true)}).strict(),
  z.object({login_required: z.literal(true)}).strict(),
]);

export const ProvidersResponseV1 = z.array(z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  needs_key: z.boolean(),
}).strict());

export const AiConfigRequestV1 = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  api_key: z.string().min(1).max(4096),
}).strict();

/**
 * `unreachable` (aditivo, OCB-010): la VM o Hermes no respondieron a tiempo, o
 * el asistente aún no está en «Configura tu IA». El front ya lo trata como
 * «no pudimos conectar, reintenta» (OCF-004).
 */
export const AiConfigResultV1 = z.enum(['ok', 'invalid_key', 'incompatible_model', 'provider_rejected', 'unreachable']);
export const AiConfigResponseV1 = z.object({result: AiConfigResultV1}).strict();

/**
 * Eventos del chat (SSE). `type` viaja como `event:` y el resto del objeto como
 * `data:`. `mcp_unavailable` solo se emite por fallos de tools `mcp__saleads__*`.
 */
export const StreamEventV1 = z.discriminatedUnion('type', [
  z.object({type: z.literal('token'), text: z.string()}).strict(),
  z.object({type: z.literal('tool_start'), name: z.string().min(1).max(200)}).strict(),
  z.object({type: z.literal('tool_end'), name: z.string().min(1).max(200), ok: z.boolean()}).strict(),
  z.object({type: z.literal('message_end')}).strict(),
  z.object({type: z.literal('mcp_unavailable')}).strict(),
  z.object({type: z.literal('provider_error'), reason: z.enum(['auth', 'quota', 'rate_limit'])}).strict(),
  z.object({type: z.literal('error')}).strict(),
  /**
   * (aditivo, OCB-016) Hermes cortó el turno o dejó de responder con la VM
   * encendida (p. ej. reinicio del gateway): cierra el turno; el front avisa y
   * deja reintentar en unos segundos.
   */
  z.object({type: z.literal('assistant_restarting')}).strict(),
  /**
   * (aditivo, solo con `voice`) Texto que Ale dice a mitad del turno, junto a
   * las tools (`assistant.commentary`), para hablarlo sin esperar la respuesta.
   */
  z.object({type: z.literal('commentary'), text: z.string()}).strict(),
  /** (aditivo, solo con `voice`) Ale empezó a razonar: una vez por turno, sin el texto del razonamiento. */
  z.object({type: z.literal('thinking')}).strict(),
]);

/** `POST /assistants/me/sessions` (OCB-011): la sesión única del usuario. */
export const SessionResponseV1 = z.object({session_id: z.string().min(1).max(200)}).strict();

/**
 * `GET /assistants/me/sessions/{id}/messages` (OCB-011): historial al recargar.
 * Solo mensajes user/assistant con texto; las tools no se exponen.
 */
export const MessagesResponseV1 = z.object({
  messages: z.array(z.object({
    id: z.string().min(1).max(200),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    created_at: z.iso.datetime({offset: true}).nullable(),
  }).strict()),
}).strict();

/**
 * Cuerpo de `POST /assistants/me/sessions/{id}/stream` (OCB-011). `voice`
 * (aditivo): turno hablado — razonamiento corto en Hermes y eventos
 * `commentary`/`thinking` para empezar a hablar antes.
 */
export const StreamRequestV1 = z.object({text: z.string().trim().min(1).max(8000), voice: z.boolean().optional()}).strict();

/**
 * Canal robot (aditivo): emparejamiento tipo Chromecast. El robot pide un código
 * (`POST /devices/pairing`), lo muestra en su cara, el dueño lo reclama desde
 * SaleADS (`POST /assistants/me/devices/claim`) y el robot sondea hasta recibir,
 * una sola vez, su credencial (`POST /devices/pairing/{id}/poll`).
 */
export const PairingStartRequestV1 = z.object({name: z.string().trim().min(1).max(60).optional()}).strict();
export const PairingStartResponseV1 = z.object({
  pairing_id: z.uuid(),
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  poll_secret: z.string().min(32).max(128),
  expires_at: z.iso.datetime({offset: true}),
  claim_url: z.url().nullable(),
}).strict();
export const PairingPollRequestV1 = z.object({poll_secret: z.string().min(32).max(128)}).strict();
export const PairingPollResponseV1 = z.discriminatedUnion('status', [
  z.object({status: z.literal('pending')}).strict(),
  z.object({status: z.literal('paired'), device_id: z.uuid(), device_token: z.string().min(40).max(200)}).strict(),
]);
export const DeviceClaimRequestV1 = z.object({code: z.string().trim().min(8).max(20)}).strict();
export const DeviceV1 = z.object({
  id: z.uuid(), name: z.string(), created_at: z.iso.datetime({offset: true}), last_seen_at: z.iso.datetime({offset: true}).nullable(),
}).strict();
export const DeviceClaimResponseV1 = z.object({device_name: z.string()}).strict();
export const DevicesResponseV1 = z.object({devices: z.array(DeviceV1)}).strict();

/**
 * `ASSISTANT_NOT_READY` (aditivo, OCB-011): 409 cuando se pide el chat y el
 * asistente no está en `ready` (preparando, configurando la IA, apagado…).
 * `ASSISTANT_RESTARTING` (aditivo, OCB-016): 503 cuando Hermes no responde al
 * abrir la sesión o el turno y la VM sigue encendida (se está reiniciando).
 */
export const ErrorCodeV1 = z.enum([
  'UNAUTHORIZED',
  'ASSISTANT_NOT_ENABLED',
  'FLAG_UNAVAILABLE',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'ASSISTANT_NOT_READY',
  'ASSISTANT_RESTARTING',
  // ORQA cliente (aditivos): aprobaciones (OSB-013) y API admin del buzón (OSB-015).
  'APPROVAL_EXPIRED',
  'APPROVAL_STALE',
  'APPROVAL_ALREADY_DECIDED',
  'FORBIDDEN',
  // MLB-013: código de un solo uso (simulado) de las aprobaciones de gasto.
  'APPROVAL_CODE_INVALID',
  'APPROVAL_CODE_EXPIRED',
  'APPROVAL_CODE_ATTEMPTS',
  // AAB-012: el presupuesto mensual del agente cambió de revisión desde que el dueño lo leyó.
  'BUDGET_REVISION_CONFLICT',
  // Canal robot (aditivo): demasiados códigos de emparejamiento fallidos seguidos.
  'PAIRING_ATTEMPTS',
  // Stock (aditivos, inventario-vivo-v1): revisión o estado en conflicto, y saldo insuficiente.
  'CONFLICT',
  'STOCK_NEGATIVE',
  'STOCK_TEXT_TOO_LONG',
  'STOCK_OTHER_RUN',
  'STOCK_ALERT_ID_REQUIRED',
]);

// ---- ORQA cliente: aprobaciones de instalación (OSB-013) ---------------------

export const ApprovalKindV1 = z.enum([
  'install_skill', 'uninstall_skill', 'install_mcp',
  // MLB-013: acciones que gastan o detienen gasto; se aprueban en la web con un código de un solo uso.
  'launch_plan', 'pause_campaign', 'change_budget', 'resume_campaign',
  // AAB-012 (D21): encender lo que el agente publicó en pausa; un botón, sin código.
  'activate_agent_publication',
]);
export const SPEND_KINDS = ['launch_plan', 'pause_campaign', 'change_budget', 'resume_campaign'] as const;
export const ApprovalStatusV1 = z.enum(['pending', 'executing', 'executed', 'failed', 'rejected', 'expired', 'stale']);
const ItemIdV1 = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

/** Ítem público que se propone instalar. Nunca texto libre del agente: nombre y resumen salen del catálogo. */
export const ApprovalItemV1 = z.object({
  id: ItemIdV1,
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(64),
  summary: z.string().trim().max(500).nullable(),
}).strict();

const MoneyV1 = z.object({amount: z.number().positive().finite(), currency: z.string().regex(/^[A-Z]{3}$/)}).strict();

/**
 * Lo que el dueño aprueba en una acción de gasto (MLB-013), armado por el servicio
 * desde el recurso (plan o campaña) y los params validados; nunca texto libre del agente.
 */
export const ApprovalDetailsV1 = z.object({
  action: z.enum(SPEND_KINDS),
  summary: z.string().max(300),
  monthly_budget: MoneyV1.nullable(),
  campaign_ids: z.array(ItemIdV1).max(50).nullable(),
  reason: z.string().max(300).nullable(),
  code_required: z.literal(true),
  result: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
}).strict();

/** Montos que pueden ser cero (gasto a la fecha, proyectado): misma forma que `MoneyV1`. */
const MoneyAtLeastZeroV1 = z.object({amount: z.number().min(0).finite(), currency: z.string().regex(/^[A-Z]{3}$/)}).strict();
const ResultV1 = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable();

/**
 * Lo que el dueño aprueba al encender una publicación del agente (AAB-012, D21, critico-final §3).
 * Todo sale de lecturas (campaign-service C-8, strategy, evaluación del presupuesto); nunca texto libre del agente.
 * Una publicación = una campaña (C-7). Montos en unidades mayores.
 */
export const AgentActivationDetailsV1 = z.object({
  action: z.literal('activate_agent_publication'),
  summary: z.string().max(300),
  publication_id: z.uuid(),
  campaign: z.object({
    campaign_id: z.uuid(),
    name: z.string().max(120),
    objective: z.string().max(64).nullable(),
    daily_budget: MoneyV1.nullable(),
    lifetime_budget: MoneyV1.nullable(),
  }).strict(),
  ad_sets: z.array(z.object({
    ad_set_id: z.uuid(),
    name: z.string().max(120),
    daily_budget: MoneyV1.nullable(),
    audience_summary: z.string().max(200).nullable(),
  }).strict()).max(50),
  ads_count: z.number().int().min(0),
  pieces: z.array(z.object({
    thumbnail_url: z.url({protocol: /^https$/}).nullable(),
    format: z.enum(['image', 'video']).nullable(),
  }).strict()).max(20),
  bets: z.array(z.object({
    bet_id: z.uuid(),
    label: z.string().max(120).nullable(),
    hypothesis: z.string().max(300).nullable(),
  }).strict()).max(20),
  skill_ref: z.object({skill_id: z.string().max(128), skill_version: z.string().max(64).nullable()}).strict().nullable(),
  budget: z.object({
    monthly: MoneyV1.nullable(),
    spent_to_date: MoneyAtLeastZeroV1,
    projected_with_activation: MoneyAtLeastZeroV1,
    exceeds: z.boolean(),
    proposed_monthly: MoneyV1.nullable(),
  }).strict(),
  code_required: z.literal(false),
  result: ResultV1,
}).strict();

/** `GET /assistants/approvals/{id}` y respuesta de approve/reject. `details` solo en las de gasto y en las del agente. */
export const ApprovalV1 = z.object({
  id: z.uuid(),
  business_id: z.uuid(),
  kind: ApprovalKindV1,
  status: ApprovalStatusV1,
  item: ApprovalItemV1,
  details: z.union([ApprovalDetailsV1, AgentActivationDetailsV1]).optional(),
  expires_at: z.iso.datetime({offset: true}),
  created_at: z.iso.datetime({offset: true}),
  decided_at: z.iso.datetime({offset: true}).nullable(),
}).strict();

/**
 * `POST /internal/assistants/approvals` (solo el MCP, con token interno y `x-user-id`).
 * Solo ids: nombre, versión y resumen los resuelve el servicio desde el catálogo.
 */
const MinorV1 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Proyección de gasto del mes que calcula integration (C-10), en el offset de Meta (`*_minor`). */
export const AgentSpendProjectionV1 = z.object({
  spent_to_date_minor: MinorV1,
  projected_active_minor: MinorV1,
  requested_delta_minor: MinorV1,
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const ApprovalParamsV1 = z.object({
  monthly_budget: MoneyV1.optional(),
  campaign_ids: z.array(ItemIdV1).min(1).max(50).optional(),
  reason: z.string().trim().min(3).max(300).optional(),
  // AAB-012: solo para `activate_agent_publication`.
  projection: AgentSpendProjectionV1.optional(),
  agent_action_id: z.uuid().optional(),
}).strict();

/** Params estrictos por tipo: lo que no corresponde al tipo es inválido. */
export const ApprovalCreateRequestV1 = z.object({
  business_id: z.uuid(),
  kind: ApprovalKindV1,
  item_id: ItemIdV1,
  params: ApprovalParamsV1.optional(),
}).strict().superRefine((value, ctx) => {
  const keys = Object.keys(value.params ?? {});
  const allowed: Record<string, string[]> = {launch_plan: ['campaign_ids'], change_budget: ['monthly_budget'], pause_campaign: ['reason'],
    activate_agent_publication: ['projection', 'agent_action_id']};
  const required: Record<string, string[]> = {change_budget: ['monthly_budget'], pause_campaign: ['reason'], activate_agent_publication: ['projection']};
  if (keys.some(key => !(allowed[value.kind] ?? []).includes(key))) ctx.addIssue({code: 'custom', message: 'params_not_allowed'});
  if ((required[value.kind] ?? []).some(key => !keys.includes(key))) ctx.addIssue({code: 'custom', message: 'params_required'});
});

/** `POST /assistants/approvals/{id}/code`: código simulado (D8), visible en la web como si llegara por mensaje. */
export const ApprovalCodeResponseV1 = z.object({
  expires_at: z.iso.datetime({offset: true}),
  attempts_left: z.number().int().min(0).max(3),
  delivery: z.literal('simulated'),
  code: z.string().regex(/^\d{6}$/).optional(),
}).strict();

/** Cuerpo opcional de `POST /assistants/approvals/{id}/approve`: el código, solo en las de gasto. */
export const ApprovalDecisionRequestV1 = z.object({code: z.string().regex(/^\d{6}$/).optional()}).strict();

/**
 * `GET|PUT /assistants/me/businesses/:businessId/agent-budget` (AAB-012, D23, C-13): el presupuesto mensual que el
 * dueño aprueba para su agente. Sin consumo. Periodo = mes calendario en la zona de la cuenta (America/Bogota por ahora).
 */
export const AgentMonthlyBudgetV1 = z.object({
  business_id: z.uuid(),
  amount: MoneyV1.nullable(),
  period: z.literal('monthly'),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  revision: z.number().int().min(1).nullable(),
  updated_at: z.iso.datetime({offset: true}).nullable(),
}).strict();
/** Cuerpo de `PUT …/agent-budget` (con `Idempotency-Key` e `If-Match: "<revision>"` o `*`). */
export const AgentMonthlyBudgetUpdateRequestV1 = z.object({amount: MoneyV1}).strict();

/** `POST /internal/assistants/agent-budget/evaluate` (Agent API y espejo): evaluación pura, en `*_minor`. */
export const AgentBudgetEvaluationRequestV1 = z.object({
  business_id: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  spent_to_date_minor: MinorV1,
  projected_active_minor: MinorV1,
  requested_delta_minor: MinorV1,
  campaign_spent_minor: MinorV1.optional(),
}).strict();
export const AgentBudgetEvaluationV1 = z.object({
  decision: z.enum(['within', 'exceeds', 'no_budget']),
  code: z.enum(['CURRENCY_MISMATCH']).nullable(),
  remaining_minor: z.number().int(),
  projected_minor: MinorV1,
  monthly_minor: MinorV1.nullable(),
  revision: z.number().int().min(1).nullable(),
  campaign_spend_cap_minor: MinorV1.nullable(),
  spend_cap_below_meta_minimum: z.boolean(),
}).strict();

/** `GET /internal/assistants/approvals/:id/verification` (C-5): integration confirma la aprobación antes de encender. */
export const ApprovalVerificationV1 = z.object({
  approval_id: z.uuid(),
  kind: ApprovalKindV1,
  business_id: z.uuid(),
  user_id: z.string(),
  item_id: z.string(),
  status: ApprovalStatusV1,
  decided_at: z.iso.datetime({offset: true}).nullable(),
}).strict();
export const ErrorResponseV1 = z.object({code: ErrorCodeV1, request_id: z.uuid()}).strict();

export type AssistantStateV1 = z.infer<typeof AssistantStateV1>;
export type ActivationResponseV1 = z.infer<typeof ActivationResponseV1>;
export type ActivationRequestV1 = z.infer<typeof ActivationRequestV1>;
export type TimezoneRequestV1 = z.infer<typeof TimezoneRequestV1>;
export type OAuthCallbackRequestV1 = z.infer<typeof OAuthCallbackRequestV1>;
export type OAuthCallbackResponseV1 = z.infer<typeof OAuthCallbackResponseV1>;
export type ProvidersResponseV1 = z.infer<typeof ProvidersResponseV1>;
export type AiConfigRequestV1 = z.infer<typeof AiConfigRequestV1>;
export type AiConfigResponseV1 = z.infer<typeof AiConfigResponseV1>;
export type StreamEventV1 = z.infer<typeof StreamEventV1>;
export type SessionResponseV1 = z.infer<typeof SessionResponseV1>;
export type MessagesResponseV1 = z.infer<typeof MessagesResponseV1>;
export type StreamRequestV1 = z.infer<typeof StreamRequestV1>;
export type PairingStartResponseV1 = z.infer<typeof PairingStartResponseV1>;
export type PairingPollResponseV1 = z.infer<typeof PairingPollResponseV1>;
export type DeviceClaimResponseV1 = z.infer<typeof DeviceClaimResponseV1>;
export type DevicesResponseV1 = z.infer<typeof DevicesResponseV1>;
export type ErrorCodeV1 = z.infer<typeof ErrorCodeV1>;
export type ErrorResponseV1 = z.infer<typeof ErrorResponseV1>;
export type ApprovalKindV1 = z.infer<typeof ApprovalKindV1>;
export type ApprovalStatusV1 = z.infer<typeof ApprovalStatusV1>;
export type ApprovalV1 = z.infer<typeof ApprovalV1>;
export type ApprovalItemV1 = z.infer<typeof ApprovalItemV1>;
export type ApprovalCreateRequestV1 = z.infer<typeof ApprovalCreateRequestV1>;

/**
 * Foto del cerebro de UN negocio (ORQA OSB-010): la parte de
 * `saleads-explorer-snapshot/1` (brain/contracts) de ese negocio. Sin
 * embeddings, sin evidencia cruda ni datos personales.
 */
export const BrainNodeFamilyV1 = z.enum(['identity', 'offer', 'market', 'competition', 'channels', 'strategy', 'operations', 'learning', 'meta', 'learned', 'other']);
export const BrainNodeStateV1 = z.enum(['observed', 'proposed', 'validated', 'superseded']);
export const BrainNodeV1 = z.object({
  id: z.string().max(64),
  type: z.string().max(64),
  family: BrainNodeFamilyV1,
  label: z.string().max(200),
  summary: z.string().max(500),
  state: BrainNodeStateV1,
  provenance: z.string().max(40),
  mentions: z.number().int().min(0),
  created_at: z.string().nullable(),
}).strict();
export const BrainEdgeV1 = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string().max(64),
  fact: z.string().max(300),
  provenance: z.string().max(40),
  valid_at: z.string().nullable(),
  invalid_at: z.string().nullable(),
}).strict();
export const BrainBusinessGraphV1 = z.object({
  business_id: z.uuid(),
  nodes: z.array(BrainNodeV1).max(500),
  edges: z.array(BrainEdgeV1).max(2000),
  stats: z.object({nodes: z.number().int(), edges: z.number().int()}).strict(),
}).strict();
/** Lo que sube la VM (todas las empresas de la VM). */
export const BrainExplorerSnapshotV1 = z.object({
  schema: z.literal('saleads-explorer-snapshot/1'),
  generated_at: z.string(),
  businesses: z.array(BrainBusinessGraphV1).max(50),
}).strict();

export const BrainSnapshotSummaryV1 = z.object({
  version: z.number().int().min(1),
  created_at: z.iso.datetime({offset: true}),
  generated_at: z.iso.datetime({offset: true}).nullable(),
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
}).strict();
/** `GET /assistants/me/businesses/:businessId/brain/snapshots?limit=` (línea de tiempo, la más nueva primero). */
export const BrainSnapshotsResponseV1 = z.object({business_id: z.uuid(), items: z.array(BrainSnapshotSummaryV1)}).strict();
/** `GET /assistants/me/businesses/:businessId/brain/snapshots/:version`. */
export const BrainSnapshotResponseV1 = BrainSnapshotSummaryV1.extend({graph: BrainBusinessGraphV1}).strict();
export type BrainBusinessGraphV1 = z.infer<typeof BrainBusinessGraphV1>;
export type BrainExplorerSnapshot = z.infer<typeof BrainExplorerSnapshotV1>;
export type BrainSnapshotsResponseV1 = z.infer<typeof BrainSnapshotsResponseV1>;
export type BrainSnapshotResponseV1 = z.infer<typeof BrainSnapshotResponseV1>;

/** Tipo de negocio del equipo de marketing (MLB-002): elige las skills por vertical. */
export const BusinessTypeV1 = z.enum(['physical_product', 'service', 'infoproduct']);
/**
 * `GET|PUT /assistants/me/businesses/:businessId/profile`. Sin fila guardada, la
 * precarga sale de BI (`source: 'bi'`, sin `updated_at`); con `both`, sin dato o
 * con el MCP caído, `business_type: null` y `needs_choice: true`.
 */
export const BusinessProfileV1 = z.object({
  business_id: z.uuid(),
  business_type: BusinessTypeV1.nullable(),
  needs_choice: z.boolean(),
  source: z.enum(['bi', 'owner']).nullable(),
  updated_at: z.iso.datetime({offset: true}).nullable(),
}).strict();
/** Cuerpo de `PUT /assistants/me/businesses/:businessId/profile`: el dueño confirma o cambia el tipo. */
export const BusinessProfileUpdateRequestV1 = z.object({business_type: BusinessTypeV1}).strict();
export type BusinessTypeV1 = z.infer<typeof BusinessTypeV1>;
export type ApprovalDetailsV1 = z.infer<typeof ApprovalDetailsV1>;
export type ApprovalParamsV1 = z.infer<typeof ApprovalParamsV1>;
export type ApprovalCodeResponseV1 = z.infer<typeof ApprovalCodeResponseV1>;
export type BusinessProfileV1 = z.infer<typeof BusinessProfileV1>;
export type BusinessProfileUpdateRequestV1 = z.infer<typeof BusinessProfileUpdateRequestV1>;
export type AgentActivationDetailsV1 = z.infer<typeof AgentActivationDetailsV1>;
export type AgentSpendProjectionV1 = z.infer<typeof AgentSpendProjectionV1>;
export type AgentMonthlyBudgetV1 = z.infer<typeof AgentMonthlyBudgetV1>;
export type AgentMonthlyBudgetUpdateRequestV1 = z.infer<typeof AgentMonthlyBudgetUpdateRequestV1>;
export type AgentBudgetEvaluationRequestV1 = z.infer<typeof AgentBudgetEvaluationRequestV1>;
export type AgentBudgetEvaluationV1 = z.infer<typeof AgentBudgetEvaluationV1>;
export type ApprovalVerificationV1 = z.infer<typeof ApprovalVerificationV1>;

// ---- Agente de marketing: foto v2, comparación y feedback del dueño (MLB-014) ----

export const BrainNodeFamilyV2 = z.enum([
  'identity', 'offer', 'market', 'competition', 'channels', 'strategy', 'operations', 'learning', 'meta', 'bet', 'verdict', 'learned', 'other',
]);
const OptText = z.string().max(300).nullable();
export const BrainNodeV2 = BrainNodeV1.extend({
  family: BrainNodeFamilyV2,
  type_label: z.string().max(64),
  stage: z.string().max(40).nullable(),
  confidence: z.enum(['baja', 'media', 'alta']).nullable(),
  verification: z.string().max(40),
  valid_from: OptText,
  learned_at: OptText,
  superseded_by: z.string().max(64).nullable(),
  scope: OptText,
  evidence_count: z.number().int().min(0).nullable(),
  outcome: z.string().max(20).nullable(),
}).strict();
const SectionIds = z.array(z.string().max(64)).max(500);
export const BrainSectionsV2 = z.object({
  my_business: SectionIds, active_bets: SectionIds, learned: SectionIds, did_not_work: SectionIds,
  your_corrections: SectionIds, to_confirm: SectionIds, history: SectionIds,
}).strict();
export const BrainBusinessGraphV2 = z.object({
  business_id: z.uuid(),
  nodes: z.array(BrainNodeV2).max(500),
  edges: z.array(BrainEdgeV1).max(2000),
  stats: z.object({nodes: z.number().int(), edges: z.number().int()}).strict(),
  sections: BrainSectionsV2,
}).strict();
export const BrainExplorerSnapshotV2 = z.object({
  schema: z.literal('saleads-explorer-snapshot/2'),
  generated_at: z.string(),
  businesses: z.array(BrainBusinessGraphV2).max(50),
}).strict();
/**
 * Hecho tipado vigente del dueño (AAB-019): ruta del vocabulario cerrado del cerebro, con su procedencia y revisión.
 * Forma exacta de `knowledge-sync.v1.facts[]` (C-29).
 */
export const BrainFactV3 = z.object({
  path: z.string().min(1).max(80),
  offering_ref: z.uuid().nullable(),
  value: z.union([z.string().max(1000), z.array(z.string().max(200)).max(30)]),
  provenance: z.enum(['owner_said', 'owner_decided', 'agent_inferred', 'platform']),
  revision_id: z.string().min(1).max(64),
  version: z.number().int().min(1),
  observed_at: z.string().max(64),
  recorded_at: z.string().max(64),
}).strict();
export const BrainBusinessGraphV3 = BrainBusinessGraphV2.extend({facts: z.array(BrainFactV3).max(200)}).strict();
export const BrainExplorerSnapshotV3 = z.object({
  schema: z.literal('saleads-explorer-snapshot/3'),
  generated_at: z.string(),
  businesses: z.array(BrainBusinessGraphV3).max(50),
}).strict();
/** Lo que sube la VM: v1 (imagen vieja del cerebro), v2 o v3 (AAB-019, con hechos tipados). */
export const BrainExplorerSnapshotAny = z.discriminatedUnion('schema', [BrainExplorerSnapshotV1, BrainExplorerSnapshotV2, BrainExplorerSnapshotV3]);
/** `GET …/brain/snapshots/:version?schema=2`. */
export const BrainSnapshotResponseV2 = BrainSnapshotSummaryV1.extend({graph: BrainBusinessGraphV2}).strict();

/** `GET …/brain/snapshots/:version/diff?from=:n`: comparación en forma v2 (una v1 se eleva). */
export const BrainSnapshotDiffV1 = z.object({
  from: z.number().int().min(1),
  to: z.number().int().min(1),
  added: z.array(BrainNodeV2),
  removed: z.array(BrainNodeV2),
  modified: z.array(z.object({id: z.string().max(64), before: BrainNodeV2, after: BrainNodeV2}).strict()),
  counts: z.object({added: z.number().int(), removed: z.number().int(), modified: z.number().int()}).strict(),
}).strict();

/** `POST …/brain/feedback`: lo que el dueño dice de una memoria; le llega a Ale por una sesión aparte (D49). */
export const BrainFeedbackRequestV1 = z.object({
  node_id: z.string().min(1).max(64),
  action: z.enum(['confirm', 'correct', 'no_longer_applies']),
  text: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'correct' && !value.text) ctx.addIssue({code: 'custom', message: 'text_required'});
});
export const BrainFeedbackResponseV1 = z.object({id: z.uuid(), status: z.enum(['pending', 'delivered'])}).strict();

export type BrainBusinessGraphV2 = z.infer<typeof BrainBusinessGraphV2>;
export type BrainFactV3 = z.infer<typeof BrainFactV3>;
export type BrainBusinessGraphV3 = z.infer<typeof BrainBusinessGraphV3>;
export type BrainNodeV2 = z.infer<typeof BrainNodeV2>;
export type BrainSnapshotResponseV2 = z.infer<typeof BrainSnapshotResponseV2>;
export type BrainSnapshotDiffV1 = z.infer<typeof BrainSnapshotDiffV1>;
export type BrainFeedbackRequestV1 = z.infer<typeof BrainFeedbackRequestV1>;
export type BrainFeedbackResponseV1 = z.infer<typeof BrainFeedbackResponseV1>;

/** Nombre de archivo (sin extensión) → schema. Orden estable para la generación. */
export const CONTRACTS_V1 = {
  'assistant-state': AssistantStateV1,
  'activation-response': ActivationResponseV1,
  'oauth-callback-request': OAuthCallbackRequestV1,
  'oauth-callback-response': OAuthCallbackResponseV1,
  'providers-response': ProvidersResponseV1,
  'ai-config-request': AiConfigRequestV1,
  'ai-config-response': AiConfigResponseV1,
  'stream-event': StreamEventV1,
  'error-response': ErrorResponseV1,
  'session-response': SessionResponseV1,
  'messages-response': MessagesResponseV1,
  'stream-request': StreamRequestV1,
  'activation-request': ActivationRequestV1,
  'timezone-request': TimezoneRequestV1,
  'approval': ApprovalV1,
  'approval-create-request': ApprovalCreateRequestV1,
  'brain-snapshots-response': BrainSnapshotsResponseV1,
  'brain-snapshot-response': BrainSnapshotResponseV1,
  'business-profile': BusinessProfileV1,
  'business-profile-update-request': BusinessProfileUpdateRequestV1,
  'approval-code-response': ApprovalCodeResponseV1,
  'approval-decision-request': ApprovalDecisionRequestV1,
  'brain-snapshot-response-v2': BrainSnapshotResponseV2,
  'brain-snapshot-diff': BrainSnapshotDiffV1,
  'brain-feedback-request': BrainFeedbackRequestV1,
  'brain-feedback-response': BrainFeedbackResponseV1,
  'agent-budget': AgentMonthlyBudgetV1,
  'agent-budget-update-request': AgentMonthlyBudgetUpdateRequestV1,
  'agent-budget-evaluation-request': AgentBudgetEvaluationRequestV1,
  'agent-budget-evaluation': AgentBudgetEvaluationV1,
  'approval-verification': ApprovalVerificationV1,
  'pairing-start-request': PairingStartRequestV1,
  'pairing-start-response': PairingStartResponseV1,
  'pairing-poll-request': PairingPollRequestV1,
  'pairing-poll-response': PairingPollResponseV1,
  'device-claim-request': DeviceClaimRequestV1,
  'device-claim-response': DeviceClaimResponseV1,
  'devices-response': DevicesResponseV1,
} as const;
