'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import type { AgentActionDetail } from '../types'
import { useAgentApprovalHref } from './approvals-path'
import {
  approvalView,
  judgeWarnings,
  metaObjects,
  stateKey,
  stepErrors,
} from '../lib/agent-trace'

interface Props {
  detail: AgentActionDetail
}

const OBJECT_LABELS = new Set(['campaign', 'adset', 'ad_set', 'ad', 'creative'])

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sa-text-tertiary text-xs">{label}</dt>
      <dd className="text-sa-text-primary text-sm break-words">{children}</dd>
    </div>
  )
}

/**
 * Detalle de una acción (MAN-001): qué se pidió, apuesta, skill, aprobación,
 * objetos en Meta, resultado, gasto, advertencias del jurado (D29) y error de
 * Meta tal cual. Todo como texto.
 */
export function AgentActionFields({ detail }: Props) {
  const t = useTranslations('autonomousTeam.trace')
  const tState = useTranslations('autonomousTeam.state')
  const format = useFormatter()
  const approval = approvalView(detail, detail.steps)
  const approvalHref = useAgentApprovalHref(detail.approval_id ?? '')
  const objects = metaObjects(detail)
  const warnings = judgeWarnings(detail)
  const errors = stepErrors(detail)
  const empty = t('noValue')
  const skill = detail.skill_ref
  return (
    <dl className="grid gap-3">
      <Field label={t('fields.requested')}>
        {detail.request_summary ?? empty}
      </Field>
      <Field label={t('fields.bet')}>
        {detail.bet_ref?.bet_label ?? empty}
      </Field>
      <Field label={t('fields.skill')}>
        {skill
          ? skill.skill_version
            ? t('skillVersion', {
                skill: skill.skill_id,
                version: skill.skill_version,
              })
            : skill.skill_id
          : empty}
      </Field>
      <Field label={t('fields.approval')}>
        {t(`approval.${approval}`)}
        {approval === 'pending' && detail.approval_id ? (
          <Link
            href={approvalHref}
            className="text-sa-agent ml-2 underline underline-offset-2"
          >
            {t('openApproval')}
          </Link>
        ) : null}
      </Field>
      {objects.length ? (
        <Field label={t('fields.objects')}>
          <ul className="flex flex-col gap-0.5">
            {objects.map(object => (
              <li
                key={`${object.type}:${object.id}`}
                className="font-mono text-xs"
              >
                {t('objectLine', {
                  type: t(
                    `objectType.${OBJECT_LABELS.has(object.type) ? object.type : 'other'}`
                  ),
                  id: object.id,
                })}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      <Field label={t('fields.result')}>
        {[tState(stateKey(detail.state)), detail.outcome_summary]
          .filter(Boolean)
          .join(' · ')}
      </Field>
      {detail.spend && detail.spend.currency ? (
        <Field label={t('fields.spend')}>
          {t('spendValue', {
            amount: format.number(detail.spend.amount, {
              style: 'currency',
              currency: detail.spend.currency,
            }),
            date: format.dateTime(new Date(detail.spend.since), {
              dateStyle: 'medium',
            }),
          })}
        </Field>
      ) : null}
      {warnings.length ? (
        <Field label={t('fields.warnings')}>
          <ul className="text-sa-state-warning list-disc pl-4">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </Field>
      ) : null}
      {errors.length ? (
        <Field label={t('fields.metaError')}>
          <ul className="text-sa-state-error flex flex-col gap-0.5 font-mono text-xs">
            {errors.map((error, index) => (
              <li key={`${index}-${error}`}>{error}</li>
            ))}
          </ul>
        </Field>
      ) : null}
    </dl>
  )
}
