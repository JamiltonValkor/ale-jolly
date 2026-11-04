import 'server-only'
import { z } from 'zod'
import { serverGateway } from '@/lib/fetch/server-gateway'
import { ResponseLocaleV1 } from '../types/first-loop.schemas'
import { servicesFor } from './service-context'
import {
  readUsableSession,
  type SalesAssistantRouteContext,
} from './with-session'
import { createMetaAssistantService } from './meta-assistant-service'
import {
  legacyFirstLoopPilotEnabled,
  legacyFirstLoopLocaleSupported,
} from './first-loop-runtime-capabilities'
import { bffError } from './bff-http'
import { isMetaAssistantUserEnabled } from './route-bindings'

const preference = z.object({
  success: z.literal(true),
  data: z.object({
    user_id: z.string().min(1),
    language_code: ResponseLocaleV1,
    updated_at: z.iso.datetime({ offset: true }),
  }),
})
const snapshot = z.object({
  response_locale: ResponseLocaleV1,
  locale_revision: z.number().int().positive(),
  source_updated_at: z.iso.datetime({ offset: true }),
})

/** URL/text language cannot replace the preference saved by this authenticated owner. */
export async function synchronizeConfiguredLanguage(
  context: SalesAssistantRouteContext,
  sourceTimeoutMs = 10_000,
  syncTimeoutMs = 90_000
): Promise<{ locale: string } | { response: Response }> {
  const value = preference.safeParse(
    await serverGateway.get<unknown>('/api/subscription/language', {
      timeout: sourceTimeoutMs,
      sentryTag: 'meta_assistant_configured_language',
    })
  )
  if (!value.success || value.data.data.user_id !== context.session.user.id)
    return { response: bffError(503, 'SERVICE_UNAVAILABLE') }
  const source = value.data.data
  // Legacy has no persisted preference endpoint. Still use only this verified owner source.
  if (legacyFirstLoopPilotEnabled()) {
    return legacyFirstLoopLocaleSupported(source.language_code)
      ? { locale: source.language_code }
      : { response: bffError(503, 'SERVICE_UNAVAILABLE') }
  }
  const result = await servicesFor(context).call({
    method: 'PUT',
    path: '/assistants/me/preferences/language',
    body: {
      language_code: source.language_code,
      source_updated_at: source.updated_at,
    },
    schema: snapshot,
    timeoutMs: syncTimeoutMs,
  })
  return result.ok
    ? { locale: result.data.response_locale }
    : { response: result.response }
}

/** Best effort for admitted owners; changing the product language keeps its existing semantics. */
export async function synchronizeMetaLanguageAfterChange(
  userId: string
): Promise<'synced' | 'pending' | 'not_applicable'> {
  if (
    !isMetaAssistantUserEnabled(userId) ||
    !process.env.META_ASSISTANT_SERVICE_URL
  )
    return 'not_applicable'
  try {
    const session = await readUsableSession()
    if (!session || session.user.id !== userId) return 'pending'
    const result = await synchronizeConfiguredLanguage(
      {
        session,
        params: {},
        services: createMetaAssistantService(session.accessToken),
      },
      2000,
      2000
    )
    return 'response' in result || legacyFirstLoopPilotEnabled()
      ? 'pending'
      : 'synced'
  } catch {
    return 'pending'
  }
}
