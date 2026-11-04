'use client'

import { createContext, useContext, type ReactNode } from 'react'

import { devicesTransport } from '../lib/devices-transport'
import type { PairingTransport } from '../lib/pairing-transport'

const PairingTransportContext = createContext<PairingTransport>(devicesTransport)

interface Props {
  transport: PairingTransport
  children: ReactNode
}

/** Elige el transporte (real o demo) para todo lo que cuelga de aquí. */
export function PairingTransportProvider({ transport, children }: Props) {
  return (
    <PairingTransportContext.Provider value={transport}>
      {children}
    </PairingTransportContext.Provider>
  )
}

export function usePairingTransport(): PairingTransport {
  return useContext(PairingTransportContext)
}

/** `?demo=1` (y nada más) enciende el modo demo, solo en desarrollo. */
export function resolveTransportMode(
  value: string | string[] | null | undefined
): PairingTransport['kind'] {
  if (process.env.NODE_ENV !== 'development') return 'http'
  const raw = Array.isArray(value) ? value[0] : value
  return raw === '1' ? 'demo' : 'http'
}
