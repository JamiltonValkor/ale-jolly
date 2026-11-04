'use client'

import { useTranslations } from 'next-intl'
import { ArrowsClockwise, WarningCircle } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { cn } from '@/lib/utils'
import {
  chatToolActivity,
  type ChatFailure,
  type ChatTurnState,
} from '../lib/chat-turn'
import { useAssistantRuntime } from '../runtime'

type ActivityKey = 'saleads' | 'other' | 'thinking'

function activityKey(turn: ChatTurnState): ActivityKey | null {
  if (turn.phase !== 'streaming') return null
  const tools = chatToolActivity(turn)
  if (tools) return tools
  return turn.current?.reply ? null : 'thinking'
}

/**
 * Indicador sobrio de lo que hace el asistente. Nunca muestra nombres de
 * tools ni argumentos. La región `status` queda siempre montada para que el
 * lector de pantalla anuncie cada cambio.
 */
export function ChatActivityIndicator({
  turn,
  className,
}: {
  turn: ChatTurnState
  className?: string
}) {
  const t = useTranslations('salesAssistant.chat.activity')
  const key = activityKey(turn)
  return (
    <p
      role="status"
      className={cn('text-sa-text-secondary min-h-5 text-sm', className)}
    >
      {key ? t(key) : ''}
    </p>
  )
}

/** El MCP de SaleADS no respondió: el chat sigue y reintenta en el próximo mensaje. */
export function ChatMcpBanner({ className }: { className?: string }) {
  const t = useTranslations('salesAssistant.chat')
  return (
    <div
      role="status"
      className={cn(
        'bg-sa-state-warning-bg border-sa-state-warning-border text-sa-text-primary flex items-start gap-3 rounded-xl border p-3 text-sm',
        className
      )}
    >
      <ArrowsClockwise
        aria-hidden="true"
        className="text-sa-state-warning mt-0.5 size-5 shrink-0"
      />
      <p>{t('mcpPaused')}</p>
    </div>
  )
}

interface FailureProps {
  failure: ChatFailure
  onRetry: () => void
  className?: string
}

/** El turno falló: mensaje simple (su IA o genérico) y «Enviar de nuevo». */
export function ChatFailureNotice({
  failure,
  onRetry,
  className,
}: FailureProps) {
  const { managedAi } = useAssistantRuntime()
  const t = useTranslations('salesAssistant.chat')
  const failureCopy = useTranslations(
    managedAi ? 'metaAssistant.chat.failure' : 'salesAssistant.chat.failure'
  )
  return (
    <div
      role="alert"
      className={cn(
        'bg-sa-state-error-bg border-sa-state-error-border flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between',
        className
      )}
    >
      <p className="text-sa-text-primary flex items-start gap-2 text-sm">
        <WarningCircle
          aria-hidden="true"
          className="text-sa-state-error mt-0.5 size-5 shrink-0"
        />
        {failureCopy(failure)}
      </p>
      <SaButton
        variant="secondary"
        size="sm"
        onClick={onRetry}
        leftIcon={ArrowsClockwise}
      >
        {t('retry')}
      </SaButton>
    </div>
  )
}
