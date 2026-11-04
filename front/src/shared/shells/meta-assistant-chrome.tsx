'use client'

import { useMemo, type ReactNode } from 'react'
import { NextIntlClientProvider, useLocale, useMessages } from 'next-intl'
import { useAleOrbHidden } from '@/features/ale'

const ASSISTANT = {
  es: { start: 'Tu asistente', inside: 'tu asistente' },
  en: { start: 'Your assistant', inside: 'your assistant' },
} as const

const ALE = /\bAle\b/g
// Empieza frase si antes no hay nada o hay un punto final.
const SENTENCE_START = /(^|[.!?])\s*$/

function rewrite(
  value: unknown,
  voice: { start: string; inside: string }
): unknown {
  if (typeof value === 'string')
    return value.replace(ALE, (_match, offset: number) =>
      SENTENCE_START.test(value.slice(0, offset)) ? voice.start : voice.inside
    )
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item, voice)])
    )
  return value
}

/**
 * Los textos del equipo autónomo hablan de «Ale» (el asistente clásico). En
 * Meta Assistant quien trabaja es tu asistente: misma frase, otro sujeto.
 */
export function toAssistantVoice<T>(messages: T, locale: string): T {
  return rewrite(
    messages,
    locale.startsWith('en') ? ASSISTANT.en : ASSISTANT.es
  ) as T
}

/**
 * Marco de toda la ruta de Meta Assistant (incluidas las aprobaciones): sin el
 * orbe de Ale y con los textos compartidos en la voz de tu asistente.
 */
export function MetaAssistantChrome({ children }: { children: ReactNode }) {
  useAleOrbHidden(true)
  const locale = useLocale()
  const messages = useMessages()
  const voiced = useMemo(
    () => ({
      ...messages,
      autonomousTeam: toAssistantVoice(messages.autonomousTeam, locale),
    }),
    [messages, locale]
  )
  return (
    <NextIntlClientProvider locale={locale} messages={voiced}>
      {children}
    </NextIntlClientProvider>
  )
}
