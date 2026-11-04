'use client'

import { useMemo } from 'react'

import { createDemoTransport } from '../lib/demo-transport'
import { devicesTransport } from '../lib/devices-transport'
import type { PairingTransport } from '../lib/pairing-transport'
import {
  useCompanionStatus,
  useTransportSignals,
} from './use-companion-queries'

/** Lo que el resto de Saleads necesita saber del compañero físico. */
export interface CompanionPresence {
  paired: boolean
  deviceName: string | null
}

/**
 * Estado del compañero fuera del flujo de sincronización (p. ej. «Hoy»).
 * Usa la misma clave de caché que el flujo: al terminar de sincronizar, quien
 * lo lea se entera sin pedirlo de nuevo. `null` mientras no se sabe.
 */
export function useCompanionLink(
  mode: PairingTransport['kind']
): CompanionPresence | null {
  const transport = useMemo<PairingTransport>(
    () => (mode === 'demo' ? createDemoTransport() : devicesTransport),
    [mode]
  )
  const { data } = useCompanionStatus({ transport })
  useTransportSignals(undefined, transport)
  return useMemo(
    () =>
      data
        ? { paired: data.paired, deviceName: data.device?.name ?? null }
        : null,
    [data]
  )
}
