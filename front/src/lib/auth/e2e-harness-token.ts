/**
 * Reconoce el access token que firma `/api/auth/test-login` para Playwright.
 *
 * Modulo sin dependencias a proposito: lo importan gateway-client y
 * firebase/auth, que corren en el navegador, y no pueden arrastrar
 * `next-auth/jwt`.
 *
 * El token es un JWT (el callback de auth lo exige) cuya firma es un marcador
 * fijo. Solo sirve para decidir si se devuelven respuestas simuladas en vez de
 * llamar a servicios reales, y quien lo consulta ya exige
 * NODE_ENV !== 'production': no concede ningun permiso.
 */
export const E2E_HARNESS_TOKEN_SIGNATURE = 'e2e-harness'

/** Literal anterior, antes de que el token tuviera forma de JWT. */
const LEGACY_E2E_ACCESS_TOKEN = 'e2e-access-token'

export function isE2eHarnessAccessToken(token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false
  if (token === LEGACY_E2E_ACCESS_TOKEN) return true
  const segments = token.split('.')
  return segments.length === 3 && segments[2] === E2E_HARNESS_TOKEN_SIGNATURE
}
