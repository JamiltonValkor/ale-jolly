import 'server-only'
import { defaultLocale, locales } from '@/i18n/config'
import {
  salesAssistantOAuthCallbackRequestSchema,
  salesAssistantOAuthCallbackResponseSchema,
} from '../types'
import { resolveBrowserOrigin } from './browser-origin'
import { createMetaAssistantService } from './meta-assistant-service'
import {
  clearMetaRelaunchCookie,
  metaRelaunchCookie,
  readMetaAuthorizeCookie,
  readMetaRelaunchUrl,
} from './meta-oauth-relaunch'
import { metaAssistantAccessFailure } from './route-bindings'
import { readUsableSession } from './with-session'

const LOGIN_ERRORS = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
])

function panelPath(request: Request): string {
  const value = (request.headers.get('cookie') ?? '').match(
    /(?:^|;\s*)NEXT_LOCALE=([^;]+)/
  )?.[1]
  const locale = locales.find(locale => locale === value) ?? defaultLocale
  return `/${locale}/dashboard/meta-assistant`
}

function redirect(location: string, relaunch?: string): Response {
  const secure = resolveBrowserOrigin()?.startsWith('https:') ?? true
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': relaunch
        ? metaRelaunchCookie(relaunch, secure)
        : clearMetaRelaunchCookie(secure),
    },
  })
}

/** Same PKCE flow, verified web owner and a single visible-login relaunch. */
export async function handleMetaOAuthCallback(
  request: Request
): Promise<Response> {
  const panel = panelPath(request)
  const query = new URL(request.url).searchParams
  const state = query.get('state')
  const session = await readUsableSession()
  const relaunch = state ? readMetaRelaunchUrl(request, state) : null
  const flow = state ? readMetaAuthorizeCookie(request, state) : null
  if (!state || !session || metaAssistantAccessFailure(session) || !flow)
    return redirect(panel)
  const login = () =>
    relaunch ? redirect(relaunch, relaunch) : redirect(panel)
  const error = query.get('error')
  if (error) return LOGIN_ERRORS.has(error) ? login() : redirect(panel)
  const parsed = salesAssistantOAuthCallbackRequestSchema.safeParse({
    code: query.get('code'),
    state,
  })
  if (!parsed.success) return redirect(panel)
  try {
    const result = await createMetaAssistantService(session.accessToken).call({
      method: 'POST',
      path: '/assistants/oauth/callback',
      body: parsed.data,
      schema: salesAssistantOAuthCallbackResponseSchema,
    })
    return result.ok && 'login_required' in result.data
      ? login()
      : redirect(panel)
  } catch {
    return redirect(panel)
  }
}
