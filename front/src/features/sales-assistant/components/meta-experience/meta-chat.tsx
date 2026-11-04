'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { LandingMessageText } from '@/shared/landing-feedback/message-text'
import { LandingFeedbackNotice } from '@/shared/landing-feedback/context-notice'
import {
  formatLandingFeedback,
  readLandingFeedback,
} from '@/shared/landing-feedback/handoff'
import { useBusinessStore } from '@/store/use-business-store'
import { useFirstLoop } from '../../hooks/use-first-loop'
import { CHAT_TEXT_MAX } from '../sales-assistant-chat-composer'
import { MetaChatView } from './meta-chat-view'
import type { RenderCompanion, RenderComposer, RenderFace } from './types'

/** Texto que otra parte de la pantalla quiere dejar escrito (p. ej. «Vincular WhatsApp»). */
export interface ChatPrefill {
  text: string
  nonce: number
}

interface Props {
  prefill?: ChatPrefill | null
  renderFace?: RenderFace
  renderCompanion?: RenderCompanion
  renderComposer?: RenderComposer
}

const renderLandingMessage = (text: string) => (
  <LandingMessageText text={text} />
)

function BusinessChat({
  businessId,
  prefill,
  renderFace,
  renderCompanion,
  renderComposer,
}: Props & { businessId: string }) {
  const errors = useTranslations('metaAssistant.firstLoop.errors')
  const flow = useFirstLoop(businessId)
  const locale = useLocale()
  const feedback = readLandingFeedback(useSearchParams())
  const businessMatches = !feedback || feedback.businessId === businessId
  const [draft, setDraft] = useState(prefill?.text ?? '')
  // Estado derivado: un pedido nuevo (otro nonce) reemplaza el borrador.
  const [seenNonce, setSeenNonce] = useState(prefill?.nonce)
  if (prefill && prefill.nonce !== seenNonce) {
    setSeenNonce(prefill.nonce)
    setDraft(prefill.text)
  }
  const send = async (text: string) => {
    const accepted = await flow.send(
      feedback ? formatLandingFeedback(feedback, text, locale) : text
    )
    if (accepted) setDraft(current => (current.trim() === text ? '' : current))
  }
  return (
    <MetaChatView
      messages={flow.state?.messages ?? []}
      historyStatus={
        flow.isLoading ? 'loading' : flow.isError ? 'error' : 'ready'
      }
      busy={flow.busy}
      canSend={
        Boolean(flow.state) &&
        !flow.isError &&
        !flow.busy &&
        !flow.uncertain &&
        businessMatches
      }
      turnFailed={flow.state?.latest_turn?.status === 'failed'}
      errorMessage={flow.mutationError ? errors(flow.mutationError) : null}
      draft={draft}
      onDraftChange={setDraft}
      onSend={send}
      onRetryHistory={() => void flow.refresh()}
      textLimit={
        CHAT_TEXT_MAX -
        (feedback ? formatLandingFeedback(feedback, '', locale).length : 0)
      }
      notice={
        feedback ? (
          <LandingFeedbackNotice
            reference={feedback}
            businessMatches={businessMatches}
          />
        ) : null
      }
      renderText={renderLandingMessage}
      renderFace={renderFace}
      renderCompanion={renderCompanion}
      renderComposer={renderComposer}
    />
  )
}

/**
 * Conversación del negocio seleccionado (mismo flujo del primer ciclo que el
 * chat anterior: cada turno es un mensaje normal), con el lenguaje nuevo.
 */
export function MetaChat({
  prefill,
  renderFace,
  renderCompanion,
  renderComposer,
}: Props) {
  const t = useTranslations('metaExperience.chat')
  const business = useBusinessStore(state => state.selectedBusiness)
  if (!business) return <p className="mu-chip">{t('selectBusiness')}</p>
  return (
    <BusinessChat
      key={business.business_id}
      businessId={business.business_id}
      prefill={prefill}
      renderFace={renderFace}
      renderCompanion={renderCompanion}
      renderComposer={renderComposer}
    />
  )
}
