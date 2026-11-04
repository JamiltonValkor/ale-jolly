'use client'

// TDD-SKIP: secciones presentacionales; cubiertas por agent-activation-approval-card.test.tsx
import type { ReactNode } from 'react'
import Image from 'next/image'
import { useFormatter, useTranslations } from 'next-intl'
import { VideoCamera } from '@phosphor-icons/react'
import { formatMoney } from '../../lib/format-money'
import type { AgentActivationDetails } from '../../types'

const MAX_PIECES = 6

export function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sa-text-tertiary text-xs font-medium tracking-wider uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-sa-text-secondary">{label}</dt>
      <dd className="text-sa-text-primary text-right font-medium">{value}</dd>
    </div>
  )
}

/** A quién: por caja, nombre + público (texto del servicio, nunca HTML) y diario. */
export function AdSetsSection({
  details,
}: {
  details: AgentActivationDetails
}) {
  const t = useTranslations('salesAssistant.approvals.agentActivation')
  const format = useFormatter()
  return (
    <Section title={t('sections.who')}>
      <ul className="flex flex-col gap-2">
        {details.ad_sets.map(adSet => (
          <li
            key={adSet.ad_set_id}
            className="border-sa-border-default rounded-lg border p-3"
          >
            <p className="text-sa-text-primary text-sm font-medium break-words">
              {adSet.name}
            </p>
            <p className="text-sa-text-secondary text-sm break-words">
              {adSet.audience_summary ?? t('audienceFallback')}
            </p>
            <p className="text-sa-text-tertiary text-xs">
              {adSet.daily_budget
                ? t('perDay', {
                    amount: formatMoney(format, adSet.daily_budget),
                  })
                : t('noDaily')}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Cuánto: diario y total de la campaña, gastado del mes, proyección y presupuesto mensual. */
export function BudgetSection({
  details,
}: {
  details: AgentActivationDetails
}) {
  const t = useTranslations('salesAssistant.approvals.agentActivation')
  const format = useFormatter()
  const { campaign, budget } = details
  return (
    <Section title={t('sections.howMuch')}>
      <dl className="flex flex-col gap-1.5">
        {campaign.daily_budget ? (
          <Row
            label={t('campaignDaily')}
            value={formatMoney(format, campaign.daily_budget)}
          />
        ) : null}
        {campaign.lifetime_budget ? (
          <Row
            label={t('campaignLifetime')}
            value={formatMoney(format, campaign.lifetime_budget)}
          />
        ) : null}
        <Row
          label={t('spentToDate')}
          value={formatMoney(format, budget.spent_to_date)}
        />
        <Row
          label={t('projected')}
          value={formatMoney(format, budget.projected_with_activation)}
        />
        <Row
          label={t('monthly')}
          value={
            budget.monthly
              ? formatMoney(format, budget.monthly)
              : t('noMonthly')
          }
        />
      </dl>
    </Section>
  )
}

/** Apuesta (leída de strategy) y skill; sin apuesta registrada se dice, no se inventa. */
export function BetSection({ details }: { details: AgentActivationDetails }) {
  const t = useTranslations('salesAssistant.approvals.agentActivation')
  const skill = details.skill_ref
  return (
    <Section title={t('sections.bet')}>
      {details.bets.length ? (
        <ul className="flex flex-col gap-2">
          {details.bets.map(bet => (
            <li key={bet.bet_id} className="text-sm">
              {bet.label ? (
                <p className="text-sa-text-primary font-medium break-words">
                  {bet.label}
                </p>
              ) : null}
              {bet.hypothesis ? (
                <p className="text-sa-text-secondary break-words">
                  {bet.hypothesis}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sa-text-secondary text-sm">{t('noBets')}</p>
      )}
      {skill ? (
        <p className="text-sa-text-tertiary text-xs">
          {skill.skill_version
            ? t('skillVersion', {
                skill: skill.skill_id,
                version: skill.skill_version,
              })
            : t('skill', { skill: skill.skill_id })}
        </p>
      ) : null}
    </Section>
  )
}

/** Piezas: máximo 6 miniaturas + «y N más»; `alt` traducido. */
export function PiecesSection({
  details,
}: {
  details: AgentActivationDetails
}) {
  const t = useTranslations('salesAssistant.approvals.agentActivation')
  const shown = details.pieces.slice(0, MAX_PIECES)
  const rest = details.pieces.length - shown.length
  return (
    <Section title={t('sections.pieces')}>
      {shown.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {shown.map((piece, index) =>
            piece.thumbnail_url ? (
              <Image
                key={`${index}-${piece.thumbnail_url}`}
                src={piece.thumbnail_url}
                alt={t('pieceAlt', { number: index + 1 })}
                width={64}
                height={64}
                unoptimized
                className="size-16 rounded-lg object-cover"
              />
            ) : (
              <div
                key={`${index}-empty`}
                role="img"
                aria-label={t('pieceAlt', { number: index + 1 })}
                className="text-sa-text-tertiary flex size-16 items-center justify-center rounded-lg bg-white/5"
              >
                {piece.format === 'video' ? (
                  <VideoCamera className="size-5" aria-hidden="true" />
                ) : null}
              </div>
            )
          )}
          {rest > 0 ? (
            <span className="text-sa-text-secondary text-sm">
              {t('piecesMore', { count: rest })}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-sa-text-secondary text-sm">{t('noPieces')}</p>
      )}
    </Section>
  )
}
