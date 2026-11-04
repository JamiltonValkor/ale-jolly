'use client'

import { useId } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { LandingMessageText } from '@/shared/landing-feedback/message-text'
import { LandingFeedbackNotice } from '@/shared/landing-feedback/context-notice'
import {
  readLandingFeedback,
  formatLandingFeedback,
} from '@/shared/landing-feedback/handoff'
import { SaCard } from '@/shared/components/sa-card'
import { useBusinessStore } from '@/store/use-business-store'
import { useFirstLoop } from '../../hooks/use-first-loop'
import { INITIAL_CHAT_TURN } from '../../lib/chat-turn'
import {
  SalesAssistantChatComposer,
  CHAT_TEXT_MAX,
} from '../sales-assistant-chat-composer'
import { ChatActivityIndicator } from '../sales-assistant-chat-notices'
import { SalesAssistantChatTranscript } from '../sales-assistant-chat-transcript'

const renderLandingMessage = (text: string) => (
  <LandingMessageText text={text} />
)

function BusinessChat({ businessId }: { businessId: string }) {
  const t = useTranslations('salesAssistant.chat')
  const errors = useTranslations('metaAssistant.firstLoop.errors')
  const titleId = useId()
  const flow = useFirstLoop(businessId)
  const locale = useLocale()
  const feedback = readLandingFeedback(useSearchParams())
  const businessMatches = !feedback || feedback.businessId === businessId
  const turn = flow.busy
    ? { ...INITIAL_CHAT_TURN, phase: 'streaming' as const }
    : INITIAL_CHAT_TURN
  const historyStatus = flow.isLoading
    ? 'loading'
    : flow.isError
      ? 'error'
      : 'ready'

  return (
    <SaCard
      variant="filled"
      role="region"
      aria-labelledby={titleId}
      className="gap-4 p-6"
      data-mask=""
      data-sentry-mask=""
    >
      <h2 id={titleId} className="text-sa-text-primary text-lg font-semibold">
        {t('title')}
      </h2>
      <SalesAssistantChatTranscript
        history={flow.state?.messages ?? []}
        historyStatus={historyStatus}
        turn={turn}
        renderText={renderLandingMessage}
      />
      <ChatActivityIndicator turn={turn} />
      {flow.mutationError && (
        <p role="alert" className="text-sa-text-secondary text-sm">
          {errors(flow.mutationError)}
        </p>
      )}
      {feedback && (
        <LandingFeedbackNotice
          reference={feedback}
          businessMatches={businessMatches}
        />
      )}
      <SalesAssistantChatComposer
        canSend={
          Boolean(flow.state) &&
          !flow.busy &&
          !flow.isError &&
          !flow.uncertain &&
          businessMatches
        }
        busy={flow.busy}
        awaitAcceptance
        textLimit={
          CHAT_TEXT_MAX -
          (feedback ? formatLandingFeedback(feedback, '', locale).length : 0)
        }
        onSend={text =>
          flow.send(
            feedback ? formatLandingFeedback(feedback, text, locale) : text
          )
        }
      />
    </SaCard>
  )
}

/** Keep the business conversation; every submitted turn is a normal message. */
export function MetaAssistantChat() {
  const t = useTranslations('metaAssistant.firstLoop')
  const business = useBusinessStore(state => state.selectedBusiness)
  if (business) {
    return (
      <BusinessChat
        key={business.business_id}
        businessId={business.business_id}
      />
    )
  }
  return (
    <SaCard variant="filled" className="p-6">
      <p className="text-sa-text-secondary">{t('selectBusiness')}</p>
    </SaCard>
  )
}
