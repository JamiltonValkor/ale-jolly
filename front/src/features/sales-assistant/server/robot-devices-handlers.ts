import 'server-only'
import { z } from 'zod'
import {
  robotDeviceClaimRequestSchema,
  robotDeviceClaimResponseSchema,
  robotDevicesResponseSchema,
} from '../types'
import { bffError, bffJson } from './bff-http'
import { isUuid, mutate, read } from './orqa-http'
import { readJsonBody } from './request-body'
import type { AssistantRouteBindings } from './route-bindings'
import { servicesFor } from './service-context'
import type { SalesAssistantHandler } from './with-session'

/**
 * Canal robot, lado del dueño (CR-004): reclamar el código que muestra la
 * cara del robot, ver sus robots y desvincular uno. Viaja con el token web de
 * la sesión, como el resto de `/assistants/me/*`; los errores v1 del servicio
 * (`NOT_FOUND` del código o de la bandera apagada, `PAIRING_ATTEMPTS`) se
 * conservan. El código nunca se registra.
 */

const CLAIM_MAX_BYTES = 512

const claim: SalesAssistantHandler = async (request, context) => {
  const body = await readJsonBody(
    request,
    robotDeviceClaimRequestSchema,
    CLAIM_MAX_BYTES
  )
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return servicesFor(context).relay({
    method: 'POST',
    path: '/assistants/me/devices/claim',
    body,
    schema: robotDeviceClaimResponseSchema,
  })
}

const list: SalesAssistantHandler = (_request, context) =>
  servicesFor(context).relay({
    method: 'GET',
    path: '/assistants/me/devices',
    schema: robotDevicesResponseSchema,
  })

/** 204 del servicio → `{ok: true}` para el navegador (como ORQA). */
const revoke: SalesAssistantHandler = async (_request, context) => {
  const { params } = context
  if (!isUuid(params.id)) return bffError(400, 'INVALID_REQUEST')
  const result = await servicesFor(context).call({
    method: 'DELETE',
    path: `/assistants/me/devices/${params.id}`,
    template: '/assistants/me/devices/:id',
    schema: z.unknown(),
  })
  return result.ok ? bffJson({ ok: true }) : result.response
}

export function createRobotDeviceRoutes(
  bindings: AssistantRouteBindings = { read, mutate }
) {
  const { read, mutate } = bindings
  return {
    devices: { GET: read(list) },
    deviceClaim: { POST: mutate(claim) },
    device: { DELETE: mutate(revoke) },
  }
}
