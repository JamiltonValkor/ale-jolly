import 'server-only'
import type { z } from 'zod'

/**
 * Lee un cuerpo JSON acotado en bytes y lo valida. Cualquier fallo es `null`
 * (el handler responde 400): nunca se registra ni se devuelve el contenido,
 * que puede traer la key de IA o texto del chat.
 */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number
): Promise<T | null> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    return null
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes) return null
  try {
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > maxBytes) return null
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
