/**
 * Stub del modo local: el `auth()` de Auth.js devuelve la sesión demo (D7).
 * Sin `server-only`: el cliente de gateway lo importa y solo lo llama en el
 * servidor, igual que con el `@/auth` de SaleADS.
 */
import { getSession } from '@/lib/local/demo-session'

export const auth = getSession
