'use client'

import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react'
import type { ExtendedSession } from '@/types/auth'

/**
 * Stub de `next-auth/react` para el modo local (D7). Se resuelve en lugar del
 * paquete por alias (tsconfig `paths` y `turbopack.resolveAlias`). La sesión
 * demo sale de `/api/auth/session`, igual que en Auth.js, con su token web.
 */

type Status = 'loading' | 'authenticated' | 'unauthenticated'
interface Snapshot {
  data: ExtendedSession | null
  status: Status
}

const LOADING: Snapshot = { data: null, status: 'loading' }
let snapshot: Snapshot = LOADING
let inflight: Promise<ExtendedSession | null> | null = null
const listeners = new Set<() => void>()

function publish(next: Snapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}

function isSession(value: unknown): value is ExtendedSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { user?: { id?: unknown } }).user?.id === 'string'
  )
}

export async function getSession(): Promise<ExtendedSession | null> {
  if (snapshot.status !== 'loading' && snapshot.data) {
    const expiresAt = snapshot.data.expiresAt ?? 0
    if (expiresAt - 60_000 > Date.now()) return snapshot.data
  }
  inflight ??= fetch('/api/auth/session', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null))
    .then((value: unknown) => {
      const session = isSession(value) ? value : null
      publish({
        data: session,
        status: session ? 'authenticated' : 'unauthenticated',
      })
      return session
    })
    .catch(() => {
      publish({ data: null, status: 'unauthenticated' })
      return null
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (snapshot.status === 'loading') void getSession()
  return () => {
    listeners.delete(listener)
  }
}

export function useSession(): Snapshot & { update: () => Promise<ExtendedSession | null> } {
  const current = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => LOADING
  )
  return { ...current, update: getSession }
}

export function SessionProvider({
  children,
  session,
}: {
  children: ReactNode
  session?: ExtendedSession | null
  [key: string]: unknown
}) {
  if (session && snapshot.status === 'loading') {
    snapshot = { data: session, status: 'authenticated' }
  }
  return createElement(Fragment, null, children)
}

export async function signIn(): Promise<void> {}
export async function signOut(): Promise<void> {}
