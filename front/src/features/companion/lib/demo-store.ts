import { z } from 'zod'

import type { DemoSignal } from './pairing-transport'

/**
 * Estado compartido del modo demo entre pestañas del mismo navegador: el
 * robot (`/companion?demo=1`) y el dashboard leen y escriben aquí, y se avisan
 * por BroadcastChannel (y por el evento `storage` como respaldo).
 */

export const DEMO_STORAGE_KEY = 'saleads.companion.demo.v1'
const CHANNEL_NAME = 'saleads-companion-demo'

const recordSchema = z.object({
  pairing_id: z.string(),
  code: z.string(),
  poll_token: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  claimed_at: z.number().nullable(),
  owner_first_name: z.string().nullable(),
  business_name: z.string().nullable(),
  device_name: z.string().nullable(),
  /** El código que este reemplazó: escribirlo da «venció», no «no coincide». */
  previous_code: z.string().nullable(),
})

const stateSchema = z.object({
  pairing: recordSchema.nullable(),
  revoked_pairing_id: z.string().nullable(),
})

export type DemoPairingRecord = z.infer<typeof recordSchema>
export type DemoState = z.infer<typeof stateSchema>

export interface BroadcastChannelLike {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(data: unknown): void
  close(): void
}

export interface DemoStore {
  read(): DemoState
  write(state: DemoState): void
  emit(signal: DemoSignal): void
  subscribe(listener: (signal: DemoSignal) => void): () => void
}

const EMPTY: DemoState = { pairing: null, revoked_pairing_id: null }

function isSignal(value: unknown): value is DemoSignal {
  return value === 'changed' || value === 'hello'
}

function defaultStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    const storage = window.localStorage
    return typeof storage?.getItem === 'function' ? storage : null
  } catch {
    return null
  }
}

function defaultChannel(): BroadcastChannelLike | null {
  return typeof window === 'undefined' ||
    typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(CHANNEL_NAME)
}

export function createDemoStore(
  env: {
    storage?: Storage | null
    channel?: BroadcastChannelLike | null
  } = {}
): DemoStore {
  const storage = env.storage === undefined ? defaultStorage() : env.storage
  const channel = env.channel === undefined ? defaultChannel() : env.channel
  const listeners = new Set<(signal: DemoSignal) => void>()
  let memory: DemoState = EMPTY

  const notify = (signal: DemoSignal) => listeners.forEach(fn => fn(signal))

  if (channel) {
    channel.onmessage = event => {
      if (isSignal(event.data)) notify(event.data)
    }
  }
  if (typeof window !== 'undefined' && storage) {
    window.addEventListener('storage', event => {
      if (event.key === DEMO_STORAGE_KEY) notify('changed')
    })
  }

  return {
    read() {
      if (!storage) return memory
      const raw = storage.getItem(DEMO_STORAGE_KEY)
      if (!raw) return EMPTY
      try {
        const parsed = stateSchema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : EMPTY
      } catch {
        return EMPTY
      }
    },
    write(state) {
      if (storage) storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state))
      else memory = state
      channel?.postMessage('changed')
      notify('changed')
    },
    emit(signal) {
      channel?.postMessage(signal)
      notify(signal)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
