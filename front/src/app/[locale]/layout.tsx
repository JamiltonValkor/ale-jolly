import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { locales } from '@/i18n/config'
import { getPublicMessages } from '@/i18n/messages'

interface LocaleLayoutProps {
  children: ReactNode
  params: Promise<{ locale: string }>
}

/** Layout de idioma del modo local: solo next-intl. */
export default async function LocaleLayout({
  children,
  params,
}: LocaleLayoutProps) {
  const { locale } = await params
  if (!locales.includes(locale as (typeof locales)[number])) notFound()
  setRequestLocale(locale)
  const messages = await getPublicMessages(locale)
  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      {children}
    </NextIntlClientProvider>
  )
}

export function generateStaticParams() {
  return locales.map(locale => ({ locale }))
}
