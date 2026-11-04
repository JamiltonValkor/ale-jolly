import 'server-only'
import { z } from 'zod'
import { readJsonBody } from '@/shared/lib/bff/request-body'
import { agentCreditCapUpdateSchema } from '../types'
import {
  relayAction,
  relayBusinessActions,
  relayObjectActions,
} from './campaign-service'
import { bffError, mutate, read, type Handler } from './http'
import { relayCreditCap, relayUpdateCreditCap } from './subscription-service'

/**
 * Rutas `/api/autonomous-team/*` (AAF-001). Validan ids y filtros antes de
 * llamar al servicio; la propiedad la decide el servicio. Los route.ts de
 * `src/app` solo reexportan estos handlers.
 */

const UUID = z.uuid()
const isUuid = (value: string | undefined): value is string =>
  UUID.safeParse(value).success
const OBJECT_TYPES = new Set(['campaign', 'ad_set', 'ad'])
// Id interno (uuid) o de Meta (numérico), como lo acepta CS.
const OBJECT_ID = /^[A-Za-z0-9-]{1,64}$/
const KIND = /^[a-z_]{1,40}$/
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/
const LIMIT = /^[0-9]{1,3}$/

const isIsoDate = (value: string) => !Number.isNaN(Date.parse(value))

/** Filtros de la lista por negocio: `since, until, kind, campaign_id, cursor, limit (1..100)`. */
function actionsQuery(url: URL): URLSearchParams | null {
  const query = new URLSearchParams()
  const get = (name: string) => url.searchParams.get(name) || null
  const rules: Array<[string, (value: string) => boolean]> = [
    ['since', isIsoDate],
    ['until', isIsoDate],
    ['kind', value => KIND.test(value)],
    ['campaign_id', value => isUuid(value)],
    ['cursor', value => CURSOR.test(value)],
    ['limit', value => LIMIT.test(value) && +value >= 1 && +value <= 100],
  ]
  for (const [name, valid] of rules) {
    const value = get(name)
    if (value === null) continue
    if (!valid(value)) return null
    query.set(name, value)
  }
  return query
}

const businessActions: Handler = async (request, { params }) => {
  const query = actionsQuery(new URL(request.url))
  if (!isUuid(params.businessId) || !query)
    return bffError(400, 'INVALID_REQUEST')
  return relayBusinessActions(params.businessId, query)
}

const action: Handler = async (_request, { params }) => {
  if (!isUuid(params.actionId)) return bffError(400, 'INVALID_REQUEST')
  return relayAction(params.actionId)
}

const objectActions: Handler = async (_request, { params }) => {
  if (
    !OBJECT_TYPES.has(params.type ?? '') ||
    !OBJECT_ID.test(params.objectId ?? '')
  )
    return bffError(400, 'INVALID_REQUEST')
  return relayObjectActions(params.type, params.objectId)
}

const creditCap: Handler = () => relayCreditCap()

/** `{cap: int ≥ 0}` estricto: `null`, negativo o decimal → 400 sin llamar al servicio. */
const updateCreditCap: Handler = async request => {
  const body = await readJsonBody(request, agentCreditCapUpdateSchema, 256)
  if (!body) return bffError(400, 'INVALID_REQUEST')
  return relayUpdateCreditCap(body)
}

export const autonomousTeamRoutes = {
  businessActions: { GET: read(businessActions) },
  action: { GET: read(action) },
  objectActions: { GET: read(objectActions) },
  creditCap: { GET: read(creditCap), PUT: mutate(updateCreditCap) },
}
