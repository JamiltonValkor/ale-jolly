import { z } from 'zod'
import {
  robotDeviceClaimResponseSchema,
  robotDevicesResponseSchema,
  type RobotDevice,
  type RobotDeviceClaim,
} from '../types'
import { requestJson } from './sales-assistant-client'

/**
 * Canal robot (CR-004): vincular, ver y desvincular el compañero físico.
 * Same-origin al BFF del runtime (`/api/meta-assistant/devices…`); los
 * errores llegan como `SalesAssistantClientError` con el código v1
 * (`NOT_FOUND`, `PAIRING_ATTEMPTS`, `UNAUTHORIZED`…).
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const revokeResponseSchema = z.object({ ok: z.literal(true) }).strict()

export function claimRobotDevice(
  code: string,
  request: typeof requestJson = requestJson
): Promise<RobotDeviceClaim> {
  return request('/devices/claim', robotDeviceClaimResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ code }),
    headers: JSON_HEADERS,
  })
}

export async function fetchRobotDevices(
  signal?: AbortSignal,
  request: typeof requestJson = requestJson
): Promise<RobotDevice[]> {
  const body = await request('/devices', robotDevicesResponseSchema, {
    signal,
  })
  return body.devices
}

export async function revokeRobotDevice(
  deviceId: string,
  request: typeof requestJson = requestJson
): Promise<void> {
  await request(
    `/devices/${encodeURIComponent(deviceId)}`,
    revokeResponseSchema,
    { method: 'DELETE' }
  )
}
