import 'server-only'
import { agentCreditCapSchema, type AgentCreditCapUpdate } from '../types'
import { relayUpstream } from './upstream'

/**
 * Tope mensual de créditos del agente en subscription-service (AAB-017, C-14).
 * El usuario sale del JWT (`authMiddleware`); el gateway no reescribe
 * `/api/subscription/**`.
 */
export const AGENT_CAP_ENDPOINT = '/api/subscription/credits/agent-cap'

export const relayCreditCap = () =>
  relayUpstream({
    method: 'GET',
    endpoint: AGENT_CAP_ENDPOINT,
    template: AGENT_CAP_ENDPOINT,
    schema: agentCreditCapSchema,
  })

export const relayUpdateCreditCap = (body: AgentCreditCapUpdate) =>
  relayUpstream({
    method: 'PUT',
    endpoint: AGENT_CAP_ENDPOINT,
    template: AGENT_CAP_ENDPOINT,
    schema: agentCreditCapSchema,
    body,
  })
