import 'server-only'
import type { UsableSession } from '@/lib/auth/session-health'
import { bffError } from './bff-http'
import { createMetaAssistantService } from './meta-assistant-service'
import {
  withSalesAssistantSession,
  type SalesAssistantHandler,
} from './with-session'

export interface AssistantRouteBindings {
  read: (
    handler: SalesAssistantHandler
  ) => ReturnType<typeof withSalesAssistantSession>
  mutate: (
    handler: SalesAssistantHandler
  ) => ReturnType<typeof withSalesAssistantSession>
}

/** Private rollout policy; callers still verify the session before remote access. */
export function isMetaAssistantUserEnabled(userId: string): boolean {
  if (!userId) return false
  return (
    process.env.META_ASSISTANT_ALL_USERS === 'true' ||
    process.env.META_ASSISTANT_ALLOWED_USER_ID?.trim() === userId
  )
}

/** All-account admission is explicit; otherwise preserve the exact pilot identity. */
export function metaAssistantAccessFailure(
  session: UsableSession
): Response | null {
  if (isMetaAssistantUserEnabled(session.user.id)) return null
  const allowed = process.env.META_ASSISTANT_ALLOWED_USER_ID?.trim()
  if (!allowed) return bffError(503, 'SERVICE_UNAVAILABLE')
  return bffError(403, 'FORBIDDEN')
}

function bindMeta(handler: SalesAssistantHandler, mutation = false) {
  return withSalesAssistantSession(
    async (request, context) => {
      const denied = metaAssistantAccessFailure(context.session)
      if (denied) return denied
      const services = createMetaAssistantService(context.session.accessToken)
      return handler(request, { ...context, services })
    },
    { mutation }
  )
}

export const metaAssistantBindings: AssistantRouteBindings = {
  read: handler => bindMeta(handler),
  mutate: handler => bindMeta(handler, true),
}
