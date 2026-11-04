import { NextIntlClientProvider } from 'next-intl'
import { notFound } from 'next/navigation'

import { getAllMessages } from '@/i18n/messages'

import { CompanionLab } from './lab-client'

type LabSearchParams = Record<string, string | string[] | undefined>

interface CompanionLabPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<LabSearchParams>
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Laboratorio del compañero (solo desarrollo). Para capturas:
 *   ?section=faces|robot|flow|demo   una sola sección
 *   ?state=pairing                   un solo estado (cara, robot o paso)
 *   ?frame=800x480|1024x600|720x720|390x844   marco del robot
 *   ?solo=1                          el marco solo, arriba a la izquierda, sin rótulos
 *   ?section=demo&open=1[&pair=CODE] el flujo real en modo demo, ya abierto
 *   ?section=voice[&speak=1]          la cara en vivo diciendo una frase («Probar voz»)
 */
export default async function CompanionPairingLabPage({
  params,
  searchParams,
}: CompanionLabPageProps) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const messages = await getAllMessages(locale)
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <CompanionLab
        locale={locale}
        section={first(query.section)}
        state={first(query.state)}
        frame={first(query.frame)}
        solo={first(query.solo) === '1'}
        open={first(query.open) === '1'}
        pair={first(query.pair)}
        speak={first(query.speak) === '1'}
      />
    </NextIntlClientProvider>
  )
}
