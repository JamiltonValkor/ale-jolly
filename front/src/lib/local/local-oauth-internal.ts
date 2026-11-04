import 'server-only'
import {
  handleMetaOAuthCallback,
  metaAssistantRoutes,
} from '@/features/sales-assistant/server'
import { resolveBrowserOrigin } from '@/shared/lib/bff/browser-origin'

/**
 * Modo local (cambio 4, `LOCAL_OAUTH_INTERNAL=true`). El `authorize_url` que
 * devuelve ale-runtime apunta al Keycloak simulado dentro de la red `ale`
 * (`https://saleads.local`), que el navegador del evaluador no resuelve ni
 * confía. El BFF da ese salto por el navegador: pide el authorize a
 * saleads-sim (`prompt=none`, sesión SSO demo), toma `code` y `state` del
 * redirect y llama el mismo callback que usaría el navegador
 * (`/api/meta-assistant/oauth/callback` → ale-runtime). Al cliente le devuelve
 * el estado de `/me`, así que solo ve «Activando…» y luego el progreso.
 * Sin la variable, la ruta se comporta igual que en SaleADS.
 */
type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>

const AUTHORIZE_TIMEOUT_MS = 10_000

export function localOAuthInternalEnabled(): boolean {
  return process.env.LOCAL_OAUTH_INTERNAL === 'true'
}

function cookiePair(setCookie: string | null): string | null {
  const pair = setCookie?.split(';')[0]?.trim()
  return pair ? pair : null
}

async function authorizeInsideNetwork(authorizeUrl: string): Promise<URL> {
  const response = await fetch(authorizeUrl, {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(AUTHORIZE_TIMEOUT_MS),
  })
  const location = response.headers.get('location')
  if (response.status < 300 || response.status >= 400 || !location)
    throw new Error(`authorize sin redirect (${response.status})`)
  return new URL(location, authorizeUrl)
}

/** Si algo falla, el panel recarga y el polling de `/me` muestra el estado real. */
function panelFallback(origin: string): Response {
  return Response.json(
    { authorize_url: `${origin}/es/dashboard/meta-assistant` },
    { headers: { 'Cache-Control': 'no-store, private' } }
  )
}

export function withLocalOAuthInternal(handler: RouteHandler): RouteHandler {
  if (!localOAuthInternalEnabled()) return handler
  return async (request, context) => {
    const response = await handler(request, context)
    if (!response.ok) return response
    const data = (await response
      .clone()
      .json()
      .catch(() => null)) as { authorize_url?: unknown } | null
    if (typeof data?.authorize_url !== 'string') return response
    const origin = resolveBrowserOrigin()
    const flowCookie = cookiePair(response.headers.get('set-cookie'))
    if (!origin || !flowCookie) return response
    try {
      const back = await authorizeInsideNetwork(data.authorize_url)
      const callback = new URL('/api/meta-assistant/oauth/callback', origin)
      callback.search = back.search
      const cookies = [request.headers.get('cookie'), flowCookie]
        .filter(Boolean)
        .join('; ')
      await handleMetaOAuthCallback(
        new Request(callback, { headers: { cookie: cookies } })
      )
      const me = await metaAssistantRoutes.me.GET(
        new Request(new URL('/api/meta-assistant/me', origin), {
          headers: {
            cookie: request.headers.get('cookie') ?? '',
            origin,
            'sec-fetch-site': 'same-origin',
          },
        }),
        { params: Promise.resolve({}) }
      )
      return me.ok ? me : panelFallback(origin)
    } catch (error) {
      console.error('[local-oauth-internal]', (error as Error).message)
      return panelFallback(origin)
    }
  }
}
