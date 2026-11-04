'use client'

import { useEffect, useState } from 'react'

const MAX_TIMEOUT_MS = 2 ** 31 - 1

function useExpired(iso: string | null): boolean {
  const [expired, setExpired] = useState<string | null>(null)
  useEffect(() => {
    if (!iso) return
    const wait = new Date(iso).getTime() - Date.now()
    // Más allá de este tope, `setTimeout` dispara de inmediato.
    if (wait > MAX_TIMEOUT_MS) return
    const timer = window.setTimeout(() => setExpired(iso), Math.max(wait, 0))
    return () => window.clearTimeout(timer)
  }, [iso])
  return iso !== null && expired === iso
}

/**
 * La URL firmada vence. Vencida o rota, se relee la lista para traer otra y,
 * mientras tanto, no se confirma: el dueño tiene que estar viendo la foto.
 */
export function useStockPhoto(
  url: string | null,
  expiresAt: string | null,
  refresh: () => void
) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  const expired = useExpired(expiresAt)
  const stale = url !== null && (expired || broken === url)
  useEffect(() => {
    if (stale) refresh()
  }, [refresh, stale, url])
  return {
    stale,
    ready: url !== null && loaded === url && !stale,
    onLoad: () => setLoaded(url),
    onError: () => setBroken(url),
  }
}
