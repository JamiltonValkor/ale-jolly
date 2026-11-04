import {
  claimRequestSchema,
  claimResponseSchema,
  companionStatusSchema,
  type CompanionDevice,
} from '../types/pairing.schemas'
import { createHttpTransport } from './http-transport'
import { CompanionPairingError, type PairingErrorCode } from './pairing-error'
import type { PairingTransport } from './pairing-transport'

/**
 * Transporte del dueño contra el canal real del robot
 * (`/api/meta-assistant/devices`). El robot sigue con su propio cliente: aquí
 * solo viven reclamar, consultar y desvincular.
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

interface RemoteDevice {
  id: string
  name: string
  created_at: string
  last_seen_at: string | null
}

const BASE = '/api/meta-assistant/devices'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

const ERROR_BY_CODE: Record<string, PairingErrorCode> = {
  NOT_FOUND: 'INVALID_CODE',
  INVALID_REQUEST: 'INVALID_CODE',
  PAIRING_ATTEMPTS: 'RATE_LIMITED',
}

async function failure(response: Response): Promise<CompanionPairingError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown
  } | null
  const code = typeof body?.code === 'string' ? body.code : ''
  if (response.status === 409) {
    return new CompanionPairingError('ALREADY_PAIRED', 409)
  }
  if (response.status === 429) {
    return new CompanionPairingError('RATE_LIMITED', 429)
  }
  return new CompanionPairingError(
    ERROR_BY_CODE[code] ?? 'UNKNOWN',
    response.status
  )
}

function toDevice(device: RemoteDevice): CompanionDevice {
  return {
    id: device.id,
    name: device.name,
    paired_at: device.created_at,
    last_seen_at: device.last_seen_at,
  }
}

export function createDevicesTransport(
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): PairingTransport {
  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${BASE}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        ...init,
      })
    } catch {
      throw new CompanionPairingError('NETWORK')
    }
  }

  async function listDevices(): Promise<RemoteDevice[]> {
    const response = await send('', { method: 'GET' })
    // Sin canal robot la ruta no existe: es «sin compañero», no un error.
    if (response.status === 404) return []
    if (!response.ok) throw await failure(response)
    const body = (await response.json().catch(() => null)) as {
      devices?: RemoteDevice[]
    } | null
    if (!Array.isArray(body?.devices)) {
      throw new CompanionPairingError('INVALID_RESPONSE', response.status)
    }
    return body.devices
  }

  return {
    ...createHttpTransport(),
    claim: async input => {
      const { code } = claimRequestSchema.parse(input)
      const response = await send('/claim', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ code }),
      })
      if (!response.ok) throw await failure(response)
      const body = (await response.json().catch(() => null)) as {
        device_name?: unknown
      } | null
      const parsed = claimResponseSchema.safeParse({
        status: 'paired',
        device_name: body?.device_name,
      })
      if (!parsed.success) {
        throw new CompanionPairingError('INVALID_RESPONSE', response.status)
      }
      return parsed.data
    },
    getCompanion: async () => {
      const devices = (await listDevices()).map(toDevice)
      const device = devices.at(-1) ?? null
      return companionStatusSchema.parse({ paired: device !== null, device })
    },
    unpair: async () => {
      for (const device of await listDevices()) {
        const response = await send(`/${encodeURIComponent(device.id)}`, {
          method: 'DELETE',
        })
        if (!response.ok) throw await failure(response)
      }
    },
  }
}

export const devicesTransport = createDevicesTransport()
