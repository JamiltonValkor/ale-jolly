'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import { SaCard } from '@/shared/components/sa-card'
import { cn } from '@/lib/utils'
import { useSalesAssistantChat } from '../hooks/use-sales-assistant-chat'
import { SalesAssistantChatComposer } from './sales-assistant-chat-composer'
import {
  ChatActivityIndicator,
  ChatFailureNotice,
  ChatMcpBanner,
} from './sales-assistant-chat-notices'
import { SalesAssistantChatTranscript } from './sales-assistant-chat-transcript'

interface Props {
  className?: string
}

/**
 * Chat con el asistente de ventas (OCF-005). Se monta en el `chatSlot` del
 * panel cuando el asistente está listo: historial al abrir, respuesta en
 * streaming, aviso si el MCP de SaleADS no responde y fallos en lenguaje
 * simple con «Enviar de nuevo».
 */
export function SalesAssistantChat({ className }: Props) {
  const t = useTranslations('salesAssistant.chat')
  const titleId = useId()
  const { history, historyStatus, turn, canSend, send, retry } =
    useSalesAssistantChat()
  const streaming = turn.phase === 'streaming'

  return (
    <SaCard
      variant="filled"
      role="region"
      aria-labelledby={titleId}
      className={cn('gap-4 p-6', className)}
    >
      <h2 id={titleId} className="text-sa-text-primary text-lg font-semibold">
        {t('title')}
      </h2>
      {turn.mcpPaused && <ChatMcpBanner />}
      <SalesAssistantChatTranscript
        history={history}
        historyStatus={historyStatus}
        turn={turn}
      />
      <ChatActivityIndicator turn={turn} />
      {turn.phase === 'failed' && turn.failure && (
        <ChatFailureNotice
          failure={turn.failure}
          onRetry={() => void retry()}
        />
      )}
      <SalesAssistantChatComposer
        canSend={canSend}
        busy={streaming}
        onSend={text => void send(text)}
      />
    </SaCard>
  )
}
