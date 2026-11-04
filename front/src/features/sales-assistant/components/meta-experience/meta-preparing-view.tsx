'use client'

import { useId, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowClockwise,
  Check,
  Clock,
  WarningCircle,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { activationStepItems } from '../../lib/panel-view'
import { preparingMood } from '../../lib/meta-experience/choreography'
import type { PreparingAlert } from '../../lib/meta-experience/preparing-alert'
import type { SalesAssistantStep } from '../../types'
import { CompanionStage } from './companion-stage'
import type { RenderCompanion } from './types'
import styles from './meta-screens.module.css'

export interface MetaPreparingViewProps {
  businessName: string | null
  step: SalesAssistantStep | null
  failed: boolean
  alert: PreparingAlert
  elapsedMinutes: number
  onRetryAccess: () => void
  retrying: boolean
  onCheckAgain: () => void
  renderCompanion?: RenderCompanion
  className?: string
}

function Notice({
  tone,
  title,
  body,
  action,
}: {
  tone: 'aviso' | 'mal'
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div
      className={styles.notice}
      data-tone={tone}
      role={tone === 'mal' ? 'alert' : 'status'}
    >
      {tone === 'mal' ? (
        <WarningCircle
          size={20}
          weight="light"
          className={styles.noticeIcon}
          aria-hidden
        />
      ) : (
        <Clock
          size={20}
          weight="light"
          className={styles.noticeIcon}
          aria-hidden
        />
      )}
      <div className={styles.noticeBody}>
        <div>
          <p className={styles.rowTitle}>{title}</p>
          <p className={styles.rowBody}>{body}</p>
        </div>
        {action}
      </div>
    </div>
  )
}

/**
 * Preparación: el compañero despierta paso a paso. Siempre dice en qué va,
 * cuánto lleva y qué puede hacer la persona; si el acceso se traba o la
 * instalación falla, hay una salida (nunca una pantalla quieta).
 */
export function MetaPreparingView({
  businessName,
  step,
  failed,
  alert,
  elapsedMinutes,
  onRetryAccess,
  retrying,
  onCheckAgain,
  renderCompanion,
  className,
}: MetaPreparingViewProps) {
  const t = useTranslations('metaExperience')
  const titleId = useId()
  const items = activationStepItems(step)
  const current = items.findIndex(item => item.state === 'current') + 1
  const mood = preparingMood({ step, failed, alert })
  return (
    <section className={cn(styles.hero, className)} aria-labelledby={titleId}>
      <CompanionStage
        size="hero"
        mood={mood}
        label={t('companion.waking')}
        renderCompanion={renderCompanion}
      />
      <div className={styles.heroCopy}>
        <h2 id={titleId} className={styles.heroTitle}>
          {failed ? t('preparing.failed.title') : t('preparing.title')}
        </h2>
        <p className={styles.lead}>
          {t('preparing.lead', {
            business: businessName ?? t('start.yourBusiness'),
          })}
        </p>
        <div className={styles.progress}>
          <div
            className={styles.segments}
            role="progressbar"
            aria-label={t('preparing.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={Math.max(0, current - 1)}
            aria-valuetext={t('preparing.progressValue', {
              current,
              total: items.length,
            })}
          >
            {items.map(item => (
              <span
                key={item.step}
                className={styles.segment}
                data-state={item.state}
              />
            ))}
          </div>
          <div className={styles.progressMeta}>
            <span>
              {t('preparing.progressValue', { current, total: items.length })}
            </span>
            <span>{t('preparing.elapsed', { minutes: elapsedMinutes })}</span>
          </div>
        </div>
        <ol className="mu-card">
          {items.map(item => (
            <li
              key={item.step}
              className={cn('mu-row', styles.step)}
              data-state={item.state}
            >
              <span className={styles.mark} data-state={item.state} aria-hidden>
                {item.state === 'done' ? (
                  <Check size={11} weight="bold" />
                ) : null}
              </span>
              <div>
                <p className={styles.rowTitle}>
                  {t(`preparing.steps.${item.step}.title`)}
                </p>
                <p className={styles.rowBody}>
                  {t(`preparing.steps.${item.step}.body`)}
                </p>
              </div>
              <span className={styles.stepState}>
                {t(`preparing.stepState.${item.state}`)}
              </span>
            </li>
          ))}
        </ol>
        {failed ? (
          <Notice
            tone="mal"
            title={t('preparing.failed.title')}
            body={t('preparing.failed.body')}
            action={
              <span>
                <button type="button" className="mu-btn" onClick={onCheckAgain}>
                  <ArrowClockwise size={16} weight="light" aria-hidden />
                  {t('preparing.failed.retry')}
                </button>
              </span>
            }
          />
        ) : alert === 'stuck' ? (
          <Notice
            tone="aviso"
            title={t('preparing.stuck.title')}
            body={t('preparing.stuck.body')}
            action={
              <span>
                <button
                  type="button"
                  className="mu-btn mu-btn-p"
                  onClick={retrying ? undefined : onRetryAccess}
                  aria-disabled={retrying || undefined}
                  aria-busy={retrying || undefined}
                >
                  <ArrowClockwise size={16} weight="light" aria-hidden />
                  {retrying
                    ? t('preparing.stuck.retrying')
                    : t('preparing.stuck.retry')}
                </button>
              </span>
            }
          />
        ) : alert === 'slow' ? (
          <Notice
            tone="aviso"
            title={t('preparing.slow.title')}
            body={t('preparing.slow.body')}
          />
        ) : null}
        {failed ? null : <p className={styles.note}>{t('preparing.leave')}</p>}
      </div>
    </section>
  )
}
