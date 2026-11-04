import 'server-only'
import { resolveBrowserOrigin } from './browser-origin'

export const META_OAUTH_RELAUNCH_COOKIE = 'sa-meta-assistant-oauth-relaunch'
const COOKIE_PATH = '/api/meta-assistant/oauth'
const CLIENT = 'mcp-saleads-meta-assistant-dev'
const BINDING_QUERY_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge_method',
  'code_challenge',
  'state',
  'prompt',
]

/** Binding to the dedicated client/callback is checked before any browser redirect. */
export function metaAuthorizeUrl(raw: string, state?: string): URL | null {
  try {
    if (raw.length > 4096) return null
    const url = new URL(raw)
    const issuer = new URL(process.env.KEYCLOAK_ISSUER ?? '')
    const origin = resolveBrowserOrigin()
    const query = url.searchParams
    if (BINDING_QUERY_KEYS.some(key => query.getAll(key).length > 1))
      return null
    if (
      !origin ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    )
      return null
    if (
      url.origin !== issuer.origin ||
      url.pathname !==
        `${issuer.pathname.replace(/\/$/, '')}/protocol/openid-connect/auth`
    )
      return null
    if (
      query.get('client_id') !== CLIENT ||
      query.get('redirect_uri') !==
        `${origin}/api/meta-assistant/oauth/callback`
    )
      return null
    if (
      query.get('response_type') !== 'code' ||
      query.get('code_challenge_method') !== 'S256'
    )
      return null
    if (
      !/^[A-Za-z0-9_-]{43,128}$/.test(query.get('code_challenge') ?? '') ||
      !query.get('state')
    )
      return null
    return state === undefined || query.get('state') === state ? url : null
  } catch {
    return null
  }
}

function attributes(secure: boolean, maxAge: number): string {
  return `Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function metaRelaunchCookie(raw: string, secure: boolean): string {
  const url = metaAuthorizeUrl(raw)
  if (!url) throw new Error('Invalid Meta authorization URL')
  return `${META_OAUTH_RELAUNCH_COOKIE}=${encodeURIComponent(url.toString())}; ${attributes(secure, 600)}`
}

export function clearMetaRelaunchCookie(secure: boolean): string {
  return `${META_OAUTH_RELAUNCH_COOKIE}=; ${attributes(secure, 0)}`
}

export function readMetaAuthorizeCookie(
  request: Request,
  state: string
): URL | null {
  const pair = (request.headers.get('cookie') ?? '')
    .split(';')
    .find(value => value.trim().startsWith(`${META_OAUTH_RELAUNCH_COOKIE}=`))
  if (!pair) return null
  try {
    const raw = decodeURIComponent(
      pair.trim().slice(META_OAUTH_RELAUNCH_COOKIE.length + 1)
    )
    return metaAuthorizeUrl(raw, state)
  } catch {
    return null
  }
}

/** After one visible relaunch the cookie has no prompt; it cannot relaunch again. */
export function readMetaRelaunchUrl(
  request: Request,
  state: string
): string | null {
  const url = readMetaAuthorizeCookie(request, state)
  if (url?.searchParams.get('prompt') !== 'none') return null
  url.searchParams.delete('prompt')
  return url.toString()
}
