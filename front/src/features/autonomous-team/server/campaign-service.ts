import 'server-only'
import { agentActionDetailSchema, agentActionsPageSchema } from '../types'
import { relayUpstream } from './upstream'

/**
 * Lecturas de la traza del agente en campaign-service (AAB-010, F-2…F-4). El
 * gateway (Envoy dev, ruta `campaign-service-v2`) reescribe `/api/campaigns`
 * a CS; CS filtra por `x-user-id` del JWT, así que un negocio ajeno devuelve
 * una página vacía y una acción ajena 404.
 */
export const CAMPAIGN_AGENTIC_PREFIX = '/api/campaigns/agentic/v1'

export function relayBusinessActions(
  businessId: string,
  query: URLSearchParams
) {
  // `?businessId` para que la verificación de propiedad del gateway aplique al negocio pedido (V-F4).
  query.set('businessId', businessId)
  return relayUpstream({
    method: 'GET',
    endpoint: `${CAMPAIGN_AGENTIC_PREFIX}/businesses/${businessId}/agent-actions?${query}`,
    template: `${CAMPAIGN_AGENTIC_PREFIX}/businesses/:id/agent-actions`,
    schema: agentActionsPageSchema,
    businessId,
  })
}

export function relayAction(actionId: string) {
  return relayUpstream({
    method: 'GET',
    endpoint: `${CAMPAIGN_AGENTIC_PREFIX}/agent-actions/${actionId}`,
    template: `${CAMPAIGN_AGENTIC_PREFIX}/agent-actions/:id`,
    schema: agentActionDetailSchema,
  })
}

export function relayObjectActions(type: string, objectId: string) {
  return relayUpstream({
    method: 'GET',
    endpoint: `${CAMPAIGN_AGENTIC_PREFIX}/objects/${type}/${objectId}/agent-actions`,
    template: `${CAMPAIGN_AGENTIC_PREFIX}/objects/:type/:id/agent-actions`,
    schema: agentActionsPageSchema,
  })
}
