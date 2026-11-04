import 'server-only'
import { defaultLocale, locales, type Locale } from '@/i18n/config'
import {
  salesAssistantOAuthCallbackRequestSchema,
  salesAssistantOAuthCallbackResponseSchema,
} from '../types'
import { callAssistantService } from './assistant-service'
import { resolveBrowserOrigin } from './browser-origin'
import { clearRelaunchCookie, readRelaunchUrl } from './oauth-relaunch'
import { readUsableSession } from './with-session'

/** Errores de Keycloak con los que el salto silencioso pasa a login visible. */
const LOGIN_ERRORS = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
])

function localeFrom(request: Request): Locale {
  const match = (request.headers.get('cookie') ?? '').match(
    /(?:^|;\s*)NEXT_LOCALE=([^;]+)/
  )
  const value = match?.[1]
  return locales.find(locale => locale === value) ?? defaultLocale
}

/** 302 sin caché ni Referer (la URL trae code y state); siempre borra la cookie. */
function redirect(location: string, secure: boolean): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': clearRelaunchCookie(secure),
    },
  })
}

async function exchange(code: string | null, state: string | null) {
  const body = salesAssistantOAuthCallbackRequestSchema.safeParse({
    code,
    state,
  })
  if (!body.success) return null
  const result = await callAssistantService({
    method: 'POST',
    path: '/assistants/oauth/callback',
    body: body.data,
    schema: salesAssistantOAuthCallbackResponseSchema,
  })
  return result.ok ? result.data : null
}

/**
 * GET del navegador al volver de Keycloak. Llama al servicio a lo sumo una
 * vez y termina en el panel, que muestra el estado real del servicio. Con
 * `login_required` relanza la authorize_url sin `prompt=none` (una vez).
 */
export async function handleOAuthCallback(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const state = query.get('state')
  const error = query.get('error')
  const secure = resolveBrowserOrigin()?.startsWith('https:') ?? true
  const panel = () =>
    redirect(`/${localeFrom(request)}/dashboard/assistant`, secure)
  const relaunch = () => {
    const url = state ? readRelaunchUrl(request, state) : null
    return url ? redirect(url, secure) : panel()
  }

  if (!state || !(await readUsableSession())) return panel()
  if (error) return LOGIN_ERRORS.has(error) ? relaunch() : panel()
  const result = await exchange(query.get('code'), state)
  return result && 'login_required' in result ? relaunch() : panel()
}
