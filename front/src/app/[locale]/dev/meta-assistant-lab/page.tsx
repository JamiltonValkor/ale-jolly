import { NextIntlClientProvider } from 'next-intl'
import { notFound } from 'next/navigation'
import { getAllMessages } from '@/i18n/messages'
import {
  MetaAssistantLabClient,
  type LabClientScreen,
} from './meta-assistant-lab-client'

const SCREENS: readonly LabClientScreen[] = [
  'start',
  'start-choose',
  'preparing',
  'stuck',
  'failed',
  'today',
  'today-new',
  'today-paired',
  'chat',
  'chat-empty',
  'limits',
  'limits-set',
  'activity',
  'activity-empty',
  'sidebar',
]

interface Props {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** Solo en desarrollo: `/es/dev/meta-assistant-lab?screen=today&companion=3d`. */
export default async function MetaAssistantLabPage({
  params,
  searchParams,
}: Props) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const messages = await getAllMessages(locale)
  const requested = typeof query.screen === 'string' ? query.screen : 'today'
  const screen = (SCREENS as readonly string[]).includes(requested)
    ? (requested as LabClientScreen)
    : 'today'
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <MetaAssistantLabClient
        screen={screen}
        companion={query.companion === '3d'}
      />
    </NextIntlClientProvider>
  )
}
