import type { ExtendedSession, User } from '@/types/auth'
import { DEMO_USER } from '@/lib/local/demo'

/**
 * Sesión demo del modo local (D7), sin Auth.js ni Keycloak. La sesión es siempre la del usuario demo y
 * su token web lo emite `saleads-sim` (grant password de Keycloak simulado).
 * Se cachea hasta 60 s antes de vencer. `LOCAL_SESSION_ACCESS_TOKEN` fija un
 * token a mano (solo depuración).
 */

const TOKEN_URL =
  process.env.KEYCLOAK_TOKEN_URL ||
  'http://saleads-sim:8090/realms/sale-ads/protocol/openid-connect/token'

interface CachedToken {
  accessToken: string
  expiresAt: number
}

let cached: CachedToken | null = null
let inflight: Promise<CachedToken | null> | null = null

async function requestToken(): Promise<CachedToken | null> {
  const fixed = process.env.LOCAL_SESSION_ACCESS_TOKEN
  if (fixed) return { accessToken: fixed, expiresAt: Date.now() + 3_600_000 }
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.LOCAL_SESSION_CLIENT_ID || 'front',
    username: process.env.LOCAL_SESSION_USERNAME || 'demo-owner',
    password: process.env.LOCAL_SESSION_PASSWORD || 'demo',
    scope: 'openid',
  })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) return null
  const data = (await response.json()) as {
    access_token?: unknown
    expires_in?: unknown
  }
  if (typeof data.access_token !== 'string' || !data.access_token) return null
  const ttl = typeof data.expires_in === 'number' ? data.expires_in : 300
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + ttl * 1000,
  }
}

async function demoToken(): Promise<CachedToken | null> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached
  inflight ??= requestToken()
    .catch(() => null)
    .finally(() => {
      inflight = null
    })
  const token = await inflight
  if (token) cached = token
  return token
}

/** El nombre que trae el JWT de saleads-sim («… (simulado)»), si viene. */
function tokenName(accessToken: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as { name?: unknown }
    if (typeof payload.name === 'string' && payload.name.trim())
      return payload.name.trim()
  } catch {
    // Token opaco (LOCAL_SESSION_ACCESS_TOKEN): se usa el nombre demo.
  }
  return DEMO_USER.name
}

export async function getSession(): Promise<ExtendedSession | null> {
  const token = await demoToken()
  if (!token) return null
  return {
    user: { ...DEMO_USER, name: tokenName(token.accessToken), roles: ['user'] },
    expires: new Date(token.expiresAt).toISOString(),
    expiresAt: token.expiresAt,
    accessToken: token.accessToken,
  } as ExtendedSession
}
