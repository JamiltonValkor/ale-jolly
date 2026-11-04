import { z } from 'zod'

import { PAIRING_CODE_PATTERN } from '../lib/pairing-code'

/**
 * Contrato del compañero físico (ver `../PAIRING-CONTRACT.md`). El back es de
 * Jamilton; estos esquemas son la frontera de confianza del front: todo lo que
 * llega se valida aquí antes de tocar la UI.
 */

export const pairingCodeSchema = z.string().regex(PAIRING_CODE_PATTERN)

/** Los tres pasos humanos de la sincronización, en orden. */
export const SYNC_STEPS = ['knowledge', 'voice', 'ready'] as const
export const syncStepSchema = z.enum(SYNC_STEPS)

// ---------- Robot (sin sesión) ----------

/** POST /api/companion/pairing */
export const createPairingResponseSchema = z.object({
  pairing_id: z.string().min(1),
  code: pairingCodeSchema,
  qr_url: z.url(),
  expires_at: z.iso.datetime({ offset: true }),
  poll_token: z.string().min(1),
})

export const PAIRING_STATUSES = [
  'waiting',
  'claimed',
  'syncing',
  'paired',
  'expired',
  'revoked',
] as const

/** GET /api/companion/pairing/{pairing_id} con `x-poll-token`. */
export const pairingStatusSchema = z.object({
  status: z.enum(PAIRING_STATUSES),
  owner_first_name: z.string().min(1).optional(),
  business_name: z.string().min(1).optional(),
  /** Opcional: paso real de la sincronización, para un progreso honesto. */
  sync_step: syncStepSchema.optional(),
})

// ---------- Dueño (con sesión) ----------

/** POST /api/meta-assistant/companion/claim */
export const claimRequestSchema = z.object({
  code: pairingCodeSchema,
  business_id: z.string().min(1).optional(),
})

export const claimResponseSchema = z.object({
  status: z.enum(['syncing', 'paired']),
  device_name: z.string().min(1),
})

export const companionDeviceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  paired_at: z.iso.datetime({ offset: true }),
  last_seen_at: z.iso.datetime({ offset: true }).nullable(),
})

/** GET /api/meta-assistant/companion */
export const companionStatusSchema = z.object({
  paired: z.boolean(),
  device: companionDeviceSchema.nullable(),
  /** Opcional: mientras sincroniza, el paso en curso. */
  sync_step: syncStepSchema.nullable().optional(),
})

export const PAIRING_ERROR_CODES = [
  'INVALID_CODE',
  'EXPIRED',
  'ALREADY_PAIRED',
  'DEVICE_OFFLINE',
  'RATE_LIMITED',
] as const

/** Cuerpo de error de los endpoints (4xx): `{ code }`. */
export const pairingErrorBodySchema = z.object({
  code: z.enum(PAIRING_ERROR_CODES),
})

export type SyncStep = z.infer<typeof syncStepSchema>
export type PairingSession = z.infer<typeof createPairingResponseSchema>
export type PairingStatusValue = (typeof PAIRING_STATUSES)[number]
export type PairingStatus = z.infer<typeof pairingStatusSchema>
export type ClaimRequest = z.infer<typeof claimRequestSchema>
export type ClaimResponse = z.infer<typeof claimResponseSchema>
export type CompanionDevice = z.infer<typeof companionDeviceSchema>
export type CompanionStatus = z.infer<typeof companionStatusSchema>
export type ContractErrorCode = (typeof PAIRING_ERROR_CODES)[number]
