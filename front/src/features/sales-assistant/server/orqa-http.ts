import 'server-only'
import { z } from 'zod'
import {
  callAssistantService,
  type AssistantServiceCall,
} from './assistant-service'
import { bffJson } from './bff-http'
import {
  withSalesAssistantSession,
  type SalesAssistantHandler,
} from './with-session'

/** Piezas comunes del BFF de ORQA (OSF-001…005). */

const UUID = z.uuid()
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/
export const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

export const isUuid = (value: string | undefined): value is string =>
  UUID.safeParse(value).success

/** `Idempotency-Key` del navegador: una por decisión, reusada en los reintentos. */
export function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key')
  return key && IDEMPOTENCY_KEY.test(key) ? key : null
}

/** Respuesta 204 del servicio → `{ok: true}` para el navegador. */
export async function relayNoContent(
  call: Omit<AssistantServiceCall<unknown>, 'schema'>
): Promise<Response> {
  const result = await callAssistantService({ ...call, schema: z.unknown() })
  return result.ok ? bffJson({ ok: true }) : result.response
}

export const read = (handler: SalesAssistantHandler) =>
  withSalesAssistantSession(handler)
export const mutate = (handler: SalesAssistantHandler) =>
  withSalesAssistantSession(handler, { mutation: true })
