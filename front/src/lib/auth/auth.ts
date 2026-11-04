import 'server-only'
import type { User } from '@/types/auth'
import { getSession } from '@/lib/local/demo-session'

/**
 * Stub del modo local (D7): mismo path de import que `@/lib/auth/auth` de
 * SaleADS. Toda sesión es la del usuario demo (ver `lib/local/demo-session`).
 */
export { getSession }
export const auth = getSession
export const getOptionalSession = getSession

export async function getCurrentUser(): Promise<User | null> {
  return (await getSession())?.user ?? null
}

export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.accessToken ?? null
}
