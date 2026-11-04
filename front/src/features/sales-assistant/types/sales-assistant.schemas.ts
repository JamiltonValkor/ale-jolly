import { z } from 'zod'
import { ORQA_CONTRACTS_V1 } from './orqa.schemas'
import { ROBOT_DEVICES_CONTRACTS_V1 } from './robot-devices.schemas'

/**
 * Contrato front ↔ servicio v1 de sa-assistant-service.
 *
 * Fuente: `sa-assistant-service/src/contracts/v1.ts` (zod) y sus JSON Schema
 * generados `contracts/one-click/v1/*.schema.json`, vendorizados en
 * `../contracts/v1/` (copiados de la rama `feat/hermes-one-click-mvp`, que
 * ya integra OCB-011, merge 5eb6dd1). El test de este archivo compara
 * `z.toJSONSchema` de cada schema con su JSON vendorizado: si el servicio cambia el contrato, se copia
 * el JSON nuevo y el test señala qué ajustar aquí.
 *
 * OCB-016 (zona horaria y reinicio) se adelantó en el front (OCF-008): sus
 * JSON (`activation-request`, `timezone-request` y los cambios aditivos de
 * `assistant-state`, `stream-event` y `error-response`) se escribieron desde
 * el contrato de la tarea y se reemplazan por los del back cuando se publique.
 */
export const SALES_ASSISTANT_STATUSES = [
  'none',
  'activating',
  'ready',
  'stopped',
  'failed',
  'deleting',
] as const

export const SALES_ASSISTANT_STEPS = [
  'preparing_access',
  'preparing_environment',
  'installing_agent',
  'configure_ai',
] as const

export const SALES_ASSISTANT_ERROR_CODES = [
  'UNAUTHORIZED',
  'ASSISTANT_NOT_ENABLED',
  'FLAG_UNAVAILABLE',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  /** 409 (OCB-011): se pidió el chat y el asistente no está en `ready`. */
  'ASSISTANT_NOT_READY',
  /** 503 (OCB-016): Hermes se está reiniciando y no se pudo iniciar el turno. */
  'ASSISTANT_RESTARTING',
  /** ORQA (OSB-013): la aprobación venció (410), el ítem cambió de versión (409) o ya se decidió (409). */
  'APPROVAL_EXPIRED',
  'APPROVAL_STALE',
  'APPROVAL_ALREADY_DECIDED',
  /** ORQA (OSB-015): la API admin del buzón exige la lista blanca del servidor (403). */
  'FORBIDDEN',
  /** Agente de marketing (MLB-013): código de un solo uso de las aprobaciones de gasto. */
  'APPROVAL_CODE_INVALID',
  'APPROVAL_CODE_EXPIRED',
  'APPROVAL_CODE_ATTEMPTS',
  /** API agencial (AAB-012): el presupuesto mensual del agente cambió de revisión (412). */
  'BUDGET_REVISION_CONFLICT',
  /** Canal robot (CR-004): demasiados códigos fallidos; se reintenta en ~10 min (429). */
  'PAIRING_ATTEMPTS',
  /** Stock (IVB-004): propuesta resuelta, vencida o superada (409). */
  'CONFLICT',
  /** Stock (IVB-003): el saldo no alcanza (409). */
  'STOCK_NEGATIVE',
] as const

export const SALES_ASSISTANT_AI_RESULTS = [
  'ok',
  'invalid_key',
  'incompatible_model',
  'provider_rejected',
  /** OCB-010: la VM o Hermes no respondieron a tiempo, o aún no toca la IA. */
  'unreachable',
] as const

/** Zona IANA que el navegador reconoce (`America/Bogota`), hasta 64 caracteres. */
export function isIanaTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value })
    return true
  } catch {
    return false
  }
}

const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/)
  .refine(isIanaTimezone)

export const salesAssistantMeSchema = z
  .object({
    status: z.enum(SALES_ASSISTANT_STATUSES),
    step: z.enum(SALES_ASSISTANT_STEPS).nullable(),
    slow: z.boolean(),
    session_id: z.string().min(1).max(200).nullable(),
    ai: z
      .object({
        configured: z.boolean(),
        provider: z.string().min(1).max(100).nullable(),
        model: z.string().min(1).max(200).nullable(),
      })
      .strict(),
    ready_since: z.iso.datetime({ offset: true }).nullable(),
    /**
     * OCB-016: zona IANA del asistente (`null` si aún no tiene). Opcional en
     * el front porque sale antes que el back: un back viejo no la manda.
     */
    timezone: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()

/** Cuerpo opcional de `POST /assistants/me/activation` (OCB-016). */
export const salesAssistantActivationRequestSchema = z
  .object({ timezone: ianaTimezoneSchema.optional() })
  .strict()

/** Cuerpo de `PUT /assistants/me/timezone` (OCB-016). */
export const salesAssistantTimezoneRequestSchema = z
  .object({ timezone: ianaTimezoneSchema })
  .strict()

export const salesAssistantActivationSchema = z.union([
  z.object({ authorize_url: z.url({ protocol: /^https?$/ }) }).strict(),
  salesAssistantMeSchema,
])

export const salesAssistantOAuthCallbackRequestSchema = z
  .object({
    code: z.string().min(1).max(4096),
    state: z.string().min(16).max(512),
  })
  .strict()

export const salesAssistantOAuthCallbackResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ login_required: z.literal(true) }).strict(),
])

export const salesAssistantProvidersSchema = z.array(
  z
    .object({
      id: z.string().min(1).max(100),
      label: z.string().min(1).max(200),
      needs_key: z.boolean(),
    })
    .strict()
)

export const salesAssistantAiRequestSchema = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    api_key: z.string().min(1).max(4096),
  })
  .strict()

export const salesAssistantAiResponseSchema = z
  .object({ result: z.enum(SALES_ASSISTANT_AI_RESULTS) })
  .strict()

/** SSE: `type` viaja como `event:` y el resto del objeto como `data:`. */
export const salesAssistantStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }).strict(),
  z
    .object({ type: z.literal('tool_start'), name: z.string().min(1).max(200) })
    .strict(),
  z
    .object({
      type: z.literal('tool_end'),
      name: z.string().min(1).max(200),
      ok: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('message_end') }).strict(),
  z.object({ type: z.literal('mcp_unavailable') }).strict(),
  z
    .object({
      type: z.literal('provider_error'),
      reason: z.enum(['auth', 'quota', 'rate_limit']),
    })
    .strict(),
  z.object({ type: z.literal('error') }).strict(),
  /** OCB-016: Hermes se reinicia; cierra el turno y el dueño reenvía. */
  z.object({ type: z.literal('assistant_restarting') }).strict(),
])

export const salesAssistantErrorSchema = z
  .object({ code: z.enum(SALES_ASSISTANT_ERROR_CODES), request_id: z.uuid() })
  .strict()

/** `POST /assistants/me/sessions` → la sesión única del usuario. */
export const salesAssistantSessionSchema = z
  .object({ session_id: z.string().min(1).max(200) })
  .strict()

/** `GET /assistants/me/sessions/{id}/messages` → historial al recargar. */
export const salesAssistantMessagesSchema = z
  .object({
    messages: z.array(
      z
        .object({
          id: z.string().min(1).max(200),
          role: z.enum(['user', 'assistant']),
          text: z.string(),
          created_at: z.iso.datetime({ offset: true }).nullable(),
        })
        .strict()
    ),
  })
  .strict()

/** Cuerpo de `POST /assistants/me/sessions/{id}/stream`. */
export const salesAssistantStreamRequestSchema = z
  .object({ text: z.string().trim().min(1).max(8000) })
  .strict()

/** Nombre del JSON Schema del servicio (sin extensión) → schema zod. */
export const SALES_ASSISTANT_CONTRACTS_V1 = {
  'assistant-state': salesAssistantMeSchema,
  'activation-response': salesAssistantActivationSchema,
  'oauth-callback-request': salesAssistantOAuthCallbackRequestSchema,
  'oauth-callback-response': salesAssistantOAuthCallbackResponseSchema,
  'providers-response': salesAssistantProvidersSchema,
  'ai-config-request': salesAssistantAiRequestSchema,
  'ai-config-response': salesAssistantAiResponseSchema,
  'stream-event': salesAssistantStreamEventSchema,
  'error-response': salesAssistantErrorSchema,
  'session-response': salesAssistantSessionSchema,
  'messages-response': salesAssistantMessagesSchema,
  'stream-request': salesAssistantStreamRequestSchema,
  'activation-request': salesAssistantActivationRequestSchema,
  'timezone-request': salesAssistantTimezoneRequestSchema,
  ...ORQA_CONTRACTS_V1,
  ...ROBOT_DEVICES_CONTRACTS_V1,
} as const
