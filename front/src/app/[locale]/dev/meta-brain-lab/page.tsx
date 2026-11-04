import { NextIntlClientProvider } from 'next-intl'
import { notFound } from 'next/navigation'

import { getAllMessages } from '@/i18n/messages'
import { MetaBrainLab, type LabState } from './meta-brain-lab'

type LabSearchParams = Record<string, string | string[] | undefined>

interface MetaBrainLabPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<LabSearchParams>
}

const STATES: readonly LabState[] = [
  'ready',
  'loading',
  'empty',
  'error',
  'stopped',
]
const MODES = ['graph', 'sections', 'changes'] as const

function pick<T extends string>(
  value: string | string[] | undefined,
  options: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' &&
    (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * Laboratorio de «Mi cerebro» (solo desarrollo): la escena completa con el
 * fixture de Dulce Abril Pastelería.
 * `?state=loading|empty|error|stopped` · `?mode=graph|sections|changes` ·
 * `?day=N` · `?stress=1` (500 ideas / 2000 relaciones) · `?select=<id>` (idea abierta).
 */
export default async function MetaBrainLabPage({
  params,
  searchParams,
}: MetaBrainLabPageProps) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const [{ locale }, query] = await Promise.all([params, searchParams])
  const messages = await getAllMessages(locale)
  const day = Number.parseInt(
    typeof query.day === 'string' ? query.day : '',
    10
  )

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="America/Bogota"
    >
      <MetaBrainLab
        state={pick(query.state, STATES, 'ready')}
        mode={pick(query.mode, MODES, 'graph')}
        day={Number.isFinite(day) ? day : null}
        stress={query.stress === '1'}
        select={typeof query.select === 'string' ? query.select : null}
      />
    </NextIntlClientProvider>
  )
}
