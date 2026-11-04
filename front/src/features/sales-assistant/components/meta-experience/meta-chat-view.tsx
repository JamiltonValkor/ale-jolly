'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowClockwise,
  Brain,
  ChartLineUp,
  Target,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { splitChatQr } from '../../lib/chat-qr'
import { chatMood } from '../../lib/meta-experience/choreography'
import { ChatWhatsAppQr } from '../chat-whatsapp-qr'
import { CompanionStage } from './companion-stage'
import { MetaChatComposer, VoiceToggle } from './meta-chat-composer'
import type {
  CompanionMood,
  ComposerRenderInput,
  RenderCompanion,
  RenderComposer,
  RenderFace,
} from './types'
import { useCompanionSpeaking } from './use-companion-speaking'
import styles from './meta-chat.module.css'

export interface MetaChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface MetaChatViewProps {
  messages: MetaChatMessage[]
  historyStatus: 'loading' | 'ready' | 'error'
  busy: boolean
  canSend: boolean
  turnFailed: boolean
  errorMessage: string | null
  draft: string
  onDraftChange: (value: string) => void
  onSend: (text: string) => void
  onRetryHistory: () => void
  textLimit: number
  notice?: ReactNode
  renderText?: (text: string) => ReactNode
  renderFace?: RenderFace
  /** El compañero 3D sentado sobre el compositor, reaccionando a la conversación. */
  renderCompanion?: RenderCompanion
  /** El compositor del chat del modo agente; sin él, el propio. */
  renderComposer?: RenderComposer
  className?: string
}

const SUGGESTIONS: { key: 'sales' | 'goal' | 'brain'; icon: Icon }[] = [
  { key: 'sales', icon: ChartLineUp },
  { key: 'goal', icon: Target },
  { key: 'brain', icon: Brain },
]

function Avatar({
  mood,
  renderFace,
  label,
}: {
  mood: CompanionMood
  renderFace?: RenderFace
  label: string
}) {
  return (
    <span className={styles.avatar}>
      {renderFace ? (
        renderFace({ mood, size: 26, label })
      ) : (
        <span
          role="img"
          aria-label={label}
          className={cn(styles.dot, 'mu-iri')}
        />
      )}
    </span>
  )
}

/** El compositor que pone la página (el del chat del modo agente). */
function ComposerSlot({
  render,
  ...input
}: ComposerRenderInput & { render: RenderComposer }) {
  return <>{render(input)}</>
}

/** Conversación con el lenguaje del chat nuevo (respuesta, burbuja, compositor). */
function AssistantAnswer({
  text,
  show,
}: {
  text: string
  show: (text: string) => ReactNode
}) {
  const segments = splitChatQr(text)
  if (!segments.some(segment => segment.kind === 'whatsapp-qr'))
    return <p className={styles.answer}>{show(text)}</p>
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {segments.map((segment, index) =>
        segment.kind === 'whatsapp-qr' ? (
          <ChatWhatsAppQr key={index} payload={segment.payload} />
        ) : (
          <p key={index} className={styles.answer}>
            {show(segment.text)}
          </p>
        )
      )}
    </div>
  )
}

export function MetaChatView(props: MetaChatViewProps) {
  const t = useTranslations('metaExperience.chat')
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const count = props.messages.length
  // La conversación usa el scroll de la página (el compositor queda fijo
  // abajo): con cada mensaje, baja hasta el final.
  useEffect(() => {
    if (count === 0 && !props.busy) return
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [count, props.busy])
  const suggest = (text: string) => {
    props.onDraftChange(text)
    inputRef.current?.focus()
  }
  const show = props.renderText ?? ((text: string) => text)
  const text = props.draft.trim()
  const ready =
    props.canSend && text.length > 0 && props.draft.length <= props.textLimit
  const send = () => {
    if (ready) props.onSend(text)
  }
  const { speaking, say } = useCompanionSpeaking(props.messages)
  const [voice, setVoice] = useState(false)
  const mood = chatMood({
    busy: props.busy,
    turnFailed: props.turnFailed,
    speaking,
    typing: props.draft.trim().length > 0,
  })
  return (
    <section
      className={cn(styles.chat, props.className)}
      aria-label={t('title')}
      data-meta-chat=""
      data-mask=""
      data-sentry-mask=""
    >
      <div
        role="log"
        aria-live="polite"
        aria-busy={props.busy}
        className={cn(styles.log, props.renderCompanion && styles.logPerched)}
      >
        {count === 0 && props.historyStatus === 'ready' ? (
          <div className={styles.empty}>
            <Avatar
              mood="idle"
              renderFace={props.renderFace}
              label={t('assistant')}
            />
            <p className={styles.emptyText}>{t('empty')}</p>
            <ul
              className={styles.suggestions}
              aria-label={t('suggestionsLabel')}
            >
              {SUGGESTIONS.map(({ key, icon: SuggestionIcon }) => (
                <li key={key}>
                  <button
                    type="button"
                    className={styles.suggestion}
                    onClick={() => suggest(t(`suggestions.${key}`))}
                  >
                    <span className={styles.glyph} aria-hidden>
                      <SuggestionIcon size={16} weight="light" />
                    </span>
                    {t(`suggestions.${key}`)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {props.historyStatus === 'loading'
          ? ['w-[62%]', 'w-[40%]', 'w-[74%]'].map(width => (
              <span
                key={width}
                className={cn('mu-skeleton block h-[18px]', styles.msg, width)}
              />
            ))
          : null}
        {props.messages.map(message =>
          message.role === 'user' ? (
            <div key={message.id} className={styles.user}>
              <p className={styles.bubble}>
                <span className="sr-only">{t('you')}: </span>
                {message.text}
              </p>
            </div>
          ) : (
            <div
              key={message.id}
              className={cn(styles.msg, styles.assistant, 'mu-rise')}
            >
              <Avatar
                mood="speaking"
                renderFace={props.renderFace}
                label={t('assistant')}
              />
              <AssistantAnswer text={message.text} show={show} />
            </div>
          )
        )}
        {props.busy ? (
          <div className={cn(styles.msg, styles.assistant)} role="status">
            <Avatar
              mood="thinking"
              renderFace={props.renderFace}
              label={t('assistant')}
            />
            <span className={cn(styles.thinking, 'mu-live-text')}>
              {t('thinking')}
            </span>
          </div>
        ) : null}
      </div>
      {props.historyStatus === 'error' ? (
        <p role="alert" className={styles.problem}>
          {t('historyError')}
          <button
            type="button"
            className="mu-btn"
            onClick={props.onRetryHistory}
          >
            <ArrowClockwise size={15} weight="light" aria-hidden />
            {t('retry')}
          </button>
        </p>
      ) : null}
      {props.turnFailed || props.errorMessage ? (
        <p role="alert" className={styles.problem}>
          {props.errorMessage ?? t('turnFailed')}
        </p>
      ) : null}
      {props.renderComposer && props.draft.length > props.textLimit ? (
        <p role="alert" className={styles.problem}>
          {t('tooLong')}
        </p>
      ) : null}
      {props.notice}
      <div className={styles.composerWrap}>
        {props.renderCompanion ? (
          <CompanionStage
            size="mini"
            mood={mood}
            label={t('assistant')}
            interactive
            say={say}
            voice={voice}
            renderCompanion={props.renderCompanion}
            className={styles.perch}
          />
        ) : null}
        {props.renderComposer ? (
          <ComposerSlot
            render={props.renderComposer}
            value={props.draft}
            onChange={props.onDraftChange}
            onSend={send}
            canSend={ready}
            textLimit={props.textLimit}
            inputRef={inputRef}
            label={t('inputLabel')}
            placeholder={t('placeholder')}
            disclaimer={t('disclaimer')}
            leading={
              props.renderCompanion ? (
                <VoiceToggle on={voice} onToggle={() => setVoice(on => !on)} />
              ) : undefined
            }
          />
        ) : (
          <MetaChatComposer
            ref={inputRef}
            value={props.draft}
            onChange={props.onDraftChange}
            onSend={props.onSend}
            canSend={props.canSend}
            textLimit={props.textLimit}
            voice={
              props.renderCompanion
                ? { on: voice, toggle: () => setVoice(on => !on) }
                : undefined
            }
          />
        )}
      </div>
      <div ref={endRef} aria-hidden />
    </section>
  )
}
