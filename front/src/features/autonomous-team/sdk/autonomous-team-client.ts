import type { z } from 'zod'
import {
  agentActionDetailSchema,
  agentActionsPageSchema,
  agentBudgetSchema,
  agentCreditCapSchema,
  budgetIfMatch,
  optionalSchema,
  type AgentActionDetail,
  type AgentActionsPage,
  type AgentBudget,
  type AgentCreditCap,
  type Optional,
} from '../types'

/**
 * Cliente del navegador del equipo autónomo (AAF-001), same-origin al BFF. El
 * token lo pone el servidor; el navegador nunca envía autoría ni actor. Las
 * rutas nuevas responden `{available:false}` mientras el back no las tenga.
 */

export const AUTONOMOUS_TEAM_BFF = '/api/autonomous-team'
const SALES_ASSISTANT_BFF = '/api/sales-assistant'
export type AssistantBffPrefix = '/api/sales-assistant' | '/api/meta-assistant'

export class AutonomousTeamClientError extends Error {
  constructor(
    /** Código estable del BFF (`INVALID_REQUEST`, `BUDGET_REVISION_CONFLICT`…) o `UNAVAILABLE`. */
    readonly code: string,
    readonly status: number | null = null
  ) {
    super(code)
    this.name = 'AutonomousTeamClientError'
  }
}

interface RequestInitLite {
  method?: 'GET' | 'PUT'
  body?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function failure(response: Response): Promise<AutonomousTeamClientError> {
  const body: unknown = await response.json().catch(() => null)
  const code =
    body && typeof body === 'object' && 'code' in body ? body.code : null
  return new AutonomousTeamClientError(
    typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
      ? code
      : 'UNAVAILABLE',
    response.status
  )
}

async function requestOptional<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestInitLite = {}
): Promise<Optional<T>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: init.headers,
      signal: init.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new AutonomousTeamClientError('UNAVAILABLE')
  }
  if (!response.ok) throw await failure(response)
  const parsed = optionalSchema(schema).safeParse(
    await response.json().catch(() => null)
  )
  if (!parsed.success) throw new AutonomousTeamClientError('INVALID_RESPONSE')
  return parsed.data as Optional<T>
}

const enc = encodeURIComponent

export interface AgentActionsFilters {
  cursor?: string | null
  limit?: number
  kind?: string
  campaignId?: string
}

export function fetchAgentActions(
  businessId: string,
  filters: AgentActionsFilters = {},
  signal?: AbortSignal
): Promise<Optional<AgentActionsPage>> {
  const query = new URLSearchParams()
  if (filters.cursor) query.set('cursor', filters.cursor)
  if (filters.limit) query.set('limit', String(filters.limit))
  if (filters.kind) query.set('kind', filters.kind)
  if (filters.campaignId) query.set('campaign_id', filters.campaignId)
  const qs = query.size ? `?${query}` : ''
  return requestOptional(
    `${AUTONOMOUS_TEAM_BFF}/businesses/${enc(businessId)}/agent-actions${qs}`,
    agentActionsPageSchema,
    { signal }
  )
}

export function fetchAgentAction(
  actionId: string,
  signal?: AbortSignal
): Promise<Optional<AgentActionDetail>> {
  return requestOptional(
    `${AUTONOMOUS_TEAM_BFF}/agent-actions/${enc(actionId)}`,
    agentActionDetailSchema,
    { signal }
  )
}

export type AgentObjectType = 'campaign' | 'ad_set' | 'ad'

export function fetchObjectAgentActions(
  type: AgentObjectType,
  objectId: string,
  signal?: AbortSignal
): Promise<Optional<AgentActionsPage>> {
  return requestOptional(
    `${AUTONOMOUS_TEAM_BFF}/objects/${type}/${enc(objectId)}/agent-actions`,
    agentActionsPageSchema,
    { signal }
  )
}

const budgetUrl = (
  businessId: string,
  assistantBffPrefix: AssistantBffPrefix = SALES_ASSISTANT_BFF
) => `${assistantBffPrefix}/businesses/${enc(businessId)}/agent-budget`

export function fetchAgentBudget(
  businessId: string,
  signal?: AbortSignal,
  assistantBffPrefix?: AssistantBffPrefix
): Promise<Optional<AgentBudget>> {
  return requestOptional(
    budgetUrl(businessId, assistantBffPrefix),
    agentBudgetSchema,
    { signal }
  )
}

export interface AgentBudgetUpdateInput {
  amount: number
  currency: string
  /** Revisión leída (`null` si aún no hay presupuesto → `If-Match: *`). */
  revision: number | null
}

export function updateAgentBudget(
  businessId: string,
  input: AgentBudgetUpdateInput,
  idempotencyKey: string,
  assistantBffPrefix?: AssistantBffPrefix
): Promise<Optional<AgentBudget>> {
  return requestOptional(
    budgetUrl(businessId, assistantBffPrefix),
    agentBudgetSchema,
    {
      method: 'PUT',
      body: JSON.stringify({
        amount: { amount: input.amount, currency: input.currency },
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'If-Match': budgetIfMatch(input.revision),
      },
    }
  )
}

export function fetchAgentCreditCap(
  signal?: AbortSignal
): Promise<Optional<AgentCreditCap>> {
  return requestOptional(
    `${AUTONOMOUS_TEAM_BFF}/credit-cap`,
    agentCreditCapSchema,
    { signal }
  )
}

export function updateAgentCreditCap(
  cap: number,
  idempotencyKey: string
): Promise<Optional<AgentCreditCap>> {
  return requestOptional(
    `${AUTONOMOUS_TEAM_BFF}/credit-cap`,
    agentCreditCapSchema,
    {
      method: 'PUT',
      body: JSON.stringify({ cap }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    }
  )
}
