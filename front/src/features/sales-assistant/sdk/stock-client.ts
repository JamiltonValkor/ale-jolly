import type { z } from 'zod'
import {
  stockAutonomyAreaSchema,
  stockAutonomySchema,
  stockItemsSchema,
  stockOrderSchema,
  stockOrdersSchema,
  stockProposalSchema,
  stockProposalsSchema,
  stockStatusResponseSchema,
  stockSummarySchema,
  type StockAreaName,
  type StockAutonomy,
  type StockAutonomyArea,
  type StockCause,
  type StockDecision,
  type StockItems,
  type StockOrder,
  type StockOrders,
  type StockProposal,
  type StockShare,
  type StockStatusResponse,
  type StockSummary,
} from '../types'
import { requestJson, type RequestInitLite } from './sales-assistant-client'

/**
 * Cliente de Stock (IVF-001). Prefijo fijo: Stock solo existe en Meta y nunca
 * pasa por el runtime clásico. Los errores llegan como
 * `SalesAssistantClientError` con su código.
 */

const BFF = '/api/meta-assistant'

const stockRequest = <T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInitLite
) => requestJson(path, schema, init, BFF)

const stockPath = (businessId: string, suffix: string) =>
  `/businesses/${encodeURIComponent(businessId)}/stock/${suffix}`

/** Encabezados de toda escritura. `Content-Type` es obligatorio aun con `{}`. */
function writeInit(
  body: object,
  revision: number,
  key: string
): RequestInitLite {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'If-Match': `"${revision}"`,
    },
  }
}

export function fetchStockStatus(
  signal?: AbortSignal
): Promise<StockStatusResponse> {
  return stockRequest('/stock/status', stockStatusResponseSchema, { signal })
}

export function fetchStockSummary(
  businessId: string,
  signal?: AbortSignal
): Promise<StockSummary> {
  return stockRequest(stockPath(businessId, 'summary'), stockSummarySchema, {
    signal,
  })
}

export function fetchStockItems(
  businessId: string,
  signal?: AbortSignal
): Promise<StockItems> {
  return stockRequest(stockPath(businessId, 'items'), stockItemsSchema, {
    signal,
  })
}

export async function fetchStockProposals(
  businessId: string,
  signal?: AbortSignal
): Promise<StockProposal[]> {
  const body = await stockRequest(
    stockPath(businessId, 'proposals?status=pendiente'),
    stockProposalsSchema,
    { signal }
  )
  return body.propuestas
}

export function fetchStockOrders(
  businessId: string,
  signal?: AbortSignal
): Promise<StockOrders> {
  return stockRequest(stockPath(businessId, 'orders'), stockOrdersSchema, {
    signal,
  })
}

/** Sin cuerpo ni revisión: repetirla no falla, y solo aplica en `negociando`. */
export function cancelStockOrder(
  businessId: string,
  orderId: string
): Promise<StockOrder> {
  return stockRequest(
    stockPath(businessId, `orders/${encodeURIComponent(orderId)}/cancel`),
    stockOrderSchema,
    { method: 'POST' }
  )
}

export function fetchStockAutonomy(
  businessId: string,
  signal?: AbortSignal
): Promise<StockAutonomy> {
  return stockRequest(stockPath(businessId, 'autonomy'), stockAutonomySchema, {
    signal,
  })
}

export interface StockDecisionInput {
  proposalId: string
  revision: number
  decision: StockDecision
  causa?: StockCause
  motivo?: string
  /** R15: solo en un conteo con variante dudosa, y siempre lo da la dueña. */
  reparto?: StockShare[]
}

export function decideStockProposal(
  businessId: string,
  {
    proposalId,
    revision,
    decision,
    causa,
    motivo,
    reparto,
  }: StockDecisionInput,
  key: string
): Promise<StockProposal> {
  const body = decision === 'approve' ? { causa, motivo, reparto } : { motivo }
  return stockRequest(
    stockPath(
      businessId,
      `proposals/${encodeURIComponent(proposalId)}/${decision}`
    ),
    stockProposalSchema,
    writeInit(body, revision, key)
  )
}

export interface StockLevelInput {
  area: StockAreaName
  revision: number
  nivel: number
  motivo?: string
}

/** Bajar de nivel, o regresar de 1 a 2. Subir más lo pide Jolly con evidencia. */
export function changeStockAutonomy(
  businessId: string,
  { area, revision, nivel, motivo }: StockLevelInput,
  key: string
): Promise<StockAutonomyArea> {
  return stockRequest(
    stockPath(businessId, `autonomy/${area}/level`),
    stockAutonomyAreaSchema,
    writeInit({ nivel, motivo }, revision, key)
  )
}
