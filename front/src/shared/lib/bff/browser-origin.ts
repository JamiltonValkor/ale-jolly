import 'server-only'

type OriginEnv = Partial<
  Record<'ASSISTANT_BFF_PUBLIC_ORIGIN' | 'AUTH_URL' | 'NEXTAUTH_URL', string>
> &
  Record<string, string | undefined>

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Origen público del front (dev.saleads.ai o localhost:3000). Server-only:
 * `ASSISTANT_BFF_PUBLIC_ORIGIN`, o el de Auth.js si no está. Se toma el
 * primer valor presente; si es inválido no se adivina otro (503).
 */
export function resolveBrowserOrigin(
  env: OriginEnv = process.env
): string | null {
  const raw = [env.ASSISTANT_BFF_PUBLIC_ORIGIN, env.AUTH_URL, env.NEXTAUTH_URL]
    .map(value => value?.trim())
    .find(Boolean)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.username || url.password) return null
    if (url.protocol === 'https:') return url.origin
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname)
      ? url.origin
      : null
  } catch {
    return null
  }
}

/**
 * Same-origin sin CSRF HMAC (ADR0028): Origin + Sec-Fetch-Site + cookies
 * SameSite. Una mutación exige Origin igual al esperado; una lectura acepta
 * la ausencia de Origin pero nunca una petición de otro sitio.
 */
export function isSameOriginRequest(
  request: Request,
  expectedOrigin: string,
  mutation: boolean
): boolean {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  if (origin !== null && origin !== expectedOrigin) return false
  if (mutation)
    return origin !== null && (site === null || site === 'same-origin')
  return site === null || site === 'same-origin' || site === 'none'
}
