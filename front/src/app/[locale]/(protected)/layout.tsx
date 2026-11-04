import type { ReactNode } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { getSession } from '@/lib/auth/auth'
import { getAllMessages } from '@/i18n/messages'
import { Providers } from '@/lib/providers'
import { LocalSessionNotice } from '@/lib/local/local-session-notice'

interface ProtectedLayoutProps {
  children: ReactNode
  params: Promise<{ locale: string }>
}

/**
 * Modo local: en vez del login de SaleADS, la sesión demo (D7). Si
 * `saleads-sim` aún no emite el token, se avisa en lugar de redirigir.
 */
export const dynamic = 'force-dynamic'

export default async function ProtectedLayout({
  children,
  params,
}: ProtectedLayoutProps) {
  const { locale } = await params
  const [session, messages] = await Promise.all([
    getSession(),
    getAllMessages(locale),
  ])
  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      <Providers session={session}>
        {session ? children : <LocalSessionNotice />}
      </Providers>
    </NextIntlClientProvider>
  )
}
