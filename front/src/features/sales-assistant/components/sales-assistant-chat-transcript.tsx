'use client'

import { memo, useEffect, useRef, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { ChatExchange, ChatTurnState } from '../lib/chat-turn'
import { splitChatQr } from '../lib/chat-qr'
import { ChatWhatsAppQr } from './chat-whatsapp-qr'
import type { SalesAssistantMessage } from '../types'

type Role = SalesAssistantMessage['role']

interface Bubble {
  key: string
  role: Role
  text: string
}

interface Props {
  history: SalesAssistantMessage[]
  historyStatus: 'loading' | 'error' | 'ready'
  turn: ChatTurnState
  className?: string
  renderText?: (text: string) => ReactNode
}

function exchangeBubbles(exchange: ChatExchange, key: string): Bubble[] {
  const bubbles: Bubble[] = [
    { key: `${key}-user`, role: 'user', text: exchange.userText },
  ]
  if (exchange.reply)
    bubbles.push({
      key: `${key}-assistant`,
      role: 'assistant',
      text: exchange.reply,
    })
  return bubbles
}

/** Historial + turnos locales (aún no sincronizados) + turno en curso. */
function toBubbles(
  history: SalesAssistantMessage[],
  turn: ChatTurnState
): Bubble[] {
  return [
    ...history.map(message => ({
      key: message.id,
      role: message.role,
      text: message.text,
    })),
    ...turn.unsynced.flatMap((exchange, index) =>
      exchangeBubbles(exchange, `local-${index}`)
    ),
    ...(turn.current ? exchangeBubbles(turn.current, 'current') : []),
  ]
}

const ChatBubble = memo(function ChatBubble({
  role,
  text,
  renderText,
}: Omit<Bubble, 'key'> & Pick<Props, 'renderText'>) {
  const t = useTranslations('salesAssistant.chat')
  const mine = role === 'user'
  return (
    <article
      className={cn(
        'flex max-w-[85%] flex-col gap-1 rounded-2xl px-4 py-3',
        mine
          ? 'bg-sa-surface-elevated self-end'
          : 'bg-sa-surface-card border-sa-border-subtle self-start border'
      )}
    >
      <p className="text-sa-text-tertiary text-xs font-medium">
        {mine ? t('you') : t('assistant')}
      </p>
      {(mine ? [{ kind: 'text' as const, text }] : splitChatQr(text)).map(
        (segment, index) =>
          segment.kind === 'whatsapp-qr' ? (
            <ChatWhatsAppQr key={index} payload={segment.payload} />
          ) : (
            <p
              key={index}
              className="text-sa-text-primary text-sm break-words whitespace-pre-wrap"
            >
              {renderText ? renderText(segment.text) : segment.text}
            </p>
          )
      )}
    </article>
  )
})

function HistoryPlaceholder({
  status,
  empty,
}: {
  status: Props['historyStatus']
  empty: boolean
}) {
  const t = useTranslations('salesAssistant.chat')
  if (status === 'loading')
    return (
      <div
        role="status"
        aria-label={t('historyLoading')}
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-12 w-2/3 self-end rounded-2xl" />
        <Skeleton className="h-16 w-3/4 rounded-2xl" />
      </div>
    )
  if (status === 'error')
    return <p className="text-sa-text-secondary text-sm">{t('historyError')}</p>
  return empty ? (
    <p className="text-sa-text-secondary text-sm">{t('empty')}</p>
  ) : null
}

/**
 * Conversación con el asistente. Es un `role="log"` con `aria-live="polite"`;
 * mientras llega la respuesta queda `aria-busy` para que el lector de
 * pantalla la anuncie completa y no token por token. Va enmascarado en los
 * replays (PostHog `data-mask`, Sentry `data-sentry-mask`).
 */
export function SalesAssistantChatTranscript({
  history,
  historyStatus,
  turn,
  className,
  renderText,
}: Props) {
  const t = useTranslations('salesAssistant.chat')
  const tail = useRef<HTMLDivElement>(null)
  const bubbles = toBubbles(history, turn)
  const lastText = bubbles.at(-1)?.text

  useEffect(() => {
    tail.current?.scrollIntoView?.({ block: 'nearest' })
  }, [bubbles.length, lastText])

  return (
    <div
      role="log"
      aria-label={t('transcript')}
      aria-live="polite"
      aria-busy={turn.phase === 'streaming'}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable log: focus lets keyboard users scroll it (WCAG 2.1.1).
      tabIndex={0}
      data-mask=""
      data-sentry-mask=""
      className={cn(
        'border-sa-border-default focus-visible:ring-sa-border-focus flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-[var(--sa-card-radius)] border p-4 outline-none focus-visible:ring-2',
        className
      )}
    >
      <HistoryPlaceholder status={historyStatus} empty={bubbles.length === 0} />
      {bubbles.map(({ key, ...bubble }) => (
        <ChatBubble key={key} {...bubble} renderText={renderText} />
      ))}
      <div ref={tail} />
    </div>
  )
}
