'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { Toaster } from 'sonner'
import type { ExtendedSession } from '@/types/auth'

/**
 * Stub del modo local de `@/lib/providers`: sesión demo, React Query y toasts.
 * Sin Auth.js, PostHog ni la captura de trazas de SaleADS.
 */
interface ProvidersProps {
  children: ReactNode
  session?: ExtendedSession | null
}

export function Providers({ children, session }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  )
  return (
    <SessionProvider session={session}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </QueryClientProvider>
    </SessionProvider>
  )
}
