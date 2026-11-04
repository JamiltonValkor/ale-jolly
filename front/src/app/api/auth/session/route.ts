import { getSession } from '@/lib/auth/auth'

/**
 * Equivalente local de `GET /api/auth/session` de Auth.js: el stub de
 * `next-auth/react` lee aquí la sesión demo (con su token web, como hace el
 * callback de sesión de SaleADS para el cliente de gateway).
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  return Response.json(session ?? {}, {
    headers: { 'Cache-Control': 'no-store, private' },
  })
}
