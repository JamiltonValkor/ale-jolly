import { z } from 'zod'

/**
 * Canal robot (CR-004): el dueño vincula su compañero físico «Ale» con el
 * código que muestra la cara del robot. Fuente: `ale-runtime`
 * (`src/contracts/v1.ts`, rama `feat/meta-voice-stream`) y sus JSON Schema
 * `contracts/one-click/v1/device-*.schema.json`, vendorizados en
 * `../contracts/v1/`. Con `ROBOT_CHANNEL_ENABLED` apagado las rutas no
 * existen (404 `NOT_FOUND`).
 */

/** `POST /assistants/me/devices/claim`: el servicio normaliza el código. */
export const robotDeviceClaimRequestSchema = z
  .object({ code: z.string().min(8).max(20) })
  .strict()

export const robotDeviceClaimResponseSchema = z
  .object({ device_name: z.string() })
  .strict()

export const robotDeviceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    created_at: z.iso.datetime({ offset: true }),
    last_seen_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()

/** `GET /assistants/me/devices`: los robots vigentes del usuario. */
export const robotDevicesResponseSchema = z
  .object({ devices: z.array(robotDeviceSchema) })
  .strict()

/** `DELETE /assistants/me/devices/{id}` responde 204 sin cuerpo. */
export const robotDeviceRevokeResponseSchema = z.union([
  z.null(),
  z.literal(''),
])

export const ROBOT_DEVICES_CONTRACTS_V1 = {
  'device-claim-request': robotDeviceClaimRequestSchema,
  'device-claim-response': robotDeviceClaimResponseSchema,
  'devices-response': robotDevicesResponseSchema,
} as const

export type RobotDevice = z.infer<typeof robotDeviceSchema>
export type RobotDeviceClaim = z.infer<typeof robotDeviceClaimResponseSchema>
