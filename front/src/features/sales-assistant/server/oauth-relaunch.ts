import 'server-only'

/**
 * Si Keycloak responde `login_required` al salto silencioso (`prompt=none`),
 * el BFF relanza la MISMA `authorize_url` sin `prompt` (login visible, sin
 * consentimiento): mismo state y mismo PKCE, así el `oauth_flows` del servicio
 * sigue valiendo. La URL la guarda el BFF al responder la activación, en una
 * cookie httpOnly acotada a la ruta del callback. No lleva secretos: el
 * verifier queda en el servicio.
 */
export const OAUTH_RELAUNCH_COOKIE = 'sa-assistant-oauth-relaunch'
const COOKIE_PATH = '/api/sales-assistant/oauth'
const MAX_AGE_SECONDS = 600

function attributes(secure: boolean, maxAge: number): string {
  const parts = [
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function relaunchCookie(authorizeUrl: string, secure: boolean): string {
  const value = encodeURIComponent(authorizeUrl)
  return `${OAUTH_RELAUNCH_COOKIE}=${value}; ${attributes(secure, MAX_AGE_SECONDS)}`
}

export function clearRelaunchCookie(secure: boolean): string {
  return `${OAUTH_RELAUNCH_COOKIE}=; ${attributes(secure, 0)}`
}

function readCookie(request: Request): string | null {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const index = pair.indexOf('=')
    if (pair.slice(0, index).trim() !== OAUTH_RELAUNCH_COOKIE) continue
    try {
      return decodeURIComponent(pair.slice(index + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/** Origen del Keycloak configurado: el único destino permitido del relanzamiento. */
function keycloakOrigin(): string | null {
  try {
    return new URL(process.env.KEYCLOAK_ISSUER ?? '').origin
  } catch {
    return null
  }
}

/**
 * URL a relanzar sin `prompt`, solo si es https, apunta al Keycloak
 * configurado y su state es el del callback.
 */
export function readRelaunchUrl(
  request: Request,
  state: string
): string | null {
  const raw = readCookie(request)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (
      url.protocol !== 'https:' ||
      url.origin !== keycloakOrigin() ||
      url.searchParams.get('state') !== state
    )
      return null
    url.searchParams.delete('prompt')
    return url.toString()
  } catch {
    return null
  }
}
