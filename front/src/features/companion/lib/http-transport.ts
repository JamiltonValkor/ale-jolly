import type { z } from 'zod'

import {
  claimRequestSchema,
  claimResponseSchema,
  companionStatusSchema,
  createPairingResponseSchema,
  pairingErrorBodySchema,
  pairingStatusSchema,
} from '../types/pairing.schemas'
import { CompanionPairingError } from './pairing-error'
import type { PairingTransport } from './pairing-transport'

/**
 * Transporte real: same-origin al BFF (las rutas son de Jamilton). El robot no
 * tiene sesión (`credentials: 'omit'`); el dueño sí (`same-origin`). Todo lo
 * que vuelve se valida con zod; un 4xx trae `{ code }` del contrato.
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const ROBOT_BASE = '/api/companion/pairing'
const OWNER_BASE = '/api/meta-assistant/companion'

async function errorFrom(response: Response): Promise<CompanionPairingError> {
  const body: unknown = await response.json().catch(() => null)
  const parsed = pairingErrorBodySchema.safeParse(body)
  if (parsed.success) {
    return new CompanionPairingError(parsed.data.code, response.status)
  }
  if (response.status === 429) {
    return new CompanionPairingError('RATE_LIMITED', 429)
  }
  return new CompanionPairingError('UNKNOWN', response.status)
}

export function createHttpTransport(
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): PairingTransport {
  async function send(url: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetchImpl(url, {
        cache: 'no-store',
        redirect: 'error',
        ...init,
      })
    } catch {
      throw new CompanionPairingError('NETWORK')
    }
    if (!response.ok) throw await errorFrom(response)
    return response
  }

  async function sendJson<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>
  ): Promise<T> {
    const response = await send(url, init)
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new CompanionPairingError('INVALID_RESPONSE', response.status)
    }
    return parsed.data
  }

  const jsonHeaders = { 'Content-Type': 'application/json' }

  return {
    kind: 'http',
    createPairing: input =>
      sendJson(
        ROBOT_BASE,
        {
          method: 'POST',
          credentials: 'omit',
          headers: jsonHeaders,
          body: JSON.stringify(
            input?.deviceId ? { device_id: input.deviceId } : {}
          ),
        },
        createPairingResponseSchema
      ),
    getPairingStatus: handle =>
      sendJson(
        `${ROBOT_BASE}/${encodeURIComponent(handle.pairing_id)}`,
        {
          method: 'GET',
          credentials: 'omit',
          headers: { 'x-poll-token': handle.poll_token },
        },
        pairingStatusSchema
      ),
    claim: input =>
      sendJson(
        `${OWNER_BASE}/claim`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: jsonHeaders,
          body: JSON.stringify(claimRequestSchema.parse(input)),
        },
        claimResponseSchema
      ),
    getCompanion: () =>
      sendJson(
        OWNER_BASE,
        { method: 'GET', credentials: 'same-origin' },
        companionStatusSchema
      ),
    unpair: async () => {
      await send(OWNER_BASE, { method: 'DELETE', credentials: 'same-origin' })
    },
  }
}

/** Instancia por defecto del front real. */
export const httpTransport = createHttpTransport()
