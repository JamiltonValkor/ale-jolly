import 'server-only'
import { randomUUID } from 'node:crypto'
import {
  salesAssistantErrorSchema,
  type SalesAssistantErrorBody,
  type SalesAssistantServiceErrorCode,
} from '../types'

/**
 * Códigos que el BFF puede devolver al navegador: los del servicio más
 * `FORBIDDEN_ORIGIN` (mutación desde otro origen). Nunca hay detalle técnico.
 */
export type SalesAssistantBffErrorCode =
  | SalesAssistantServiceErrorCode
  | 'FORBIDDEN_ORIGIN'

export const SALES_ASSISTANT_PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
} as const

export function bffError(
  status: number,
  code: SalesAssistantBffErrorCode,
  requestId: string = randomUUID()
): Response {
  return Response.json(
    { code, request_id: requestId },
    { status, headers: SALES_ASSISTANT_PRIVATE_HEADERS }
  )
}

export function bffJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: SALES_ASSISTANT_PRIVATE_HEADERS,
  })
}

export function isServiceErrorBody(
  value: unknown
): value is SalesAssistantErrorBody {
  return salesAssistantErrorSchema.safeParse(value).success
}
