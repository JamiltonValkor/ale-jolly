import { NextResponse, type NextRequest } from 'next/server'
import createIntlMiddleware from 'next-intl/middleware'
import { locales, defaultLocale } from './i18n/config'

/**
 * Modo local: solo la parte next-intl de `src/proxy.ts` de SaleADS. Sin
 * Auth.js ni suscripción: la sesión demo siempre existe. La raíz lleva a
 * Meta Assistant, la única pantalla del modo local.
 */
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

const HOME = '/dashboard/meta-assistant'

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const bare = locales.find(locale => pathname === `/${locale}`)
  if (pathname === '/' || bare) {
    const url = request.nextUrl.clone()
    url.pathname = `/${bare ?? defaultLocale}${HOME}`
    return NextResponse.redirect(url)
  }
  return intlMiddleware(request)
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|ingest|monitoring|__gw|.*\\..*).*)'],
}
