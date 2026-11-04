'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useBrainDiff } from '../../hooks/use-orqa-queries'
import { SalesAssistantClientError } from '../../sdk/sales-assistant-client'
import type { BrainSnapshots } from '../../types'
import { BrainTimeline } from './brain-timeline'

interface Props {
  businessId: string
  items: BrainSnapshots['items']
}

/** «Qué cambió» entre dos fotos (MLF-003): agregadas, retiradas y modificadas. */
export function BrainDiff({ businessId, items }: Props) {
  const t = useTranslations('salesAssistant.brain.diff')
  const [to, setTo] = useState<number | null>(items[0]?.version ?? null)
  const [from, setFrom] = useState<number | null>(items[1]?.version ?? null)
  const diff = useBrainDiff(businessId, from, to)
  if (items.length < 2)
    return <p className="text-sa-text-tertiary text-sm">{t('needTwo')}</p>
  const notYet =
    diff.error instanceof SalesAssistantClientError &&
    diff.error.code === 'NOT_FOUND'
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-sa-text-tertiary text-xs">{t('from')}</p>
          <BrainTimeline items={items} version={from ?? 0} onChange={setFrom} />
        </div>
        <div>
          <p className="text-sa-text-tertiary text-xs">{t('to')}</p>
          <BrainTimeline items={items} version={to ?? 0} onChange={setTo} />
        </div>
      </div>
      {notYet ? (
        <p role="status" className="text-sa-text-tertiary text-sm">
          {t('notYet')}
        </p>
      ) : null}
      {diff.isError && !notYet ? (
        <p role="alert" className="text-sa-text-secondary text-sm">
          {t('error')}
        </p>
      ) : null}
      {diff.data ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-sa-text-secondary">
            {t('counts', diff.data.counts)}
          </p>
          {(['added', 'removed'] as const).map(kind =>
            diff.data[kind].length ? (
              <div key={kind} className="flex flex-col gap-1">
                <h4 className="text-sa-text-primary font-medium">{t(kind)}</h4>
                <ul className="text-sa-text-secondary list-disc pl-5">
                  {diff.data[kind].map(node => (
                    <li key={node.id}>
                      {node.label}{' '}
                      <span className="text-sa-text-tertiary">
                        · {node.type_label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
          {diff.data.modified.length ? (
            <div className="flex flex-col gap-1">
              <h4 className="text-sa-text-primary font-medium">
                {t('modified')}
              </h4>
              <ul className="text-sa-text-secondary list-disc pl-5">
                {diff.data.modified.map(change => (
                  <li key={change.id}>
                    {change.after.label}
                    {change.before.stage !== change.after.stage ? (
                      <span className="text-sa-text-tertiary">
                        {' '}
                        · {change.before.stage ?? '—'} →{' '}
                        {change.after.stage ?? '—'}
                      </span>
                    ) : null}
                    {change.before.confidence !== change.after.confidence ? (
                      <span className="text-sa-text-tertiary">
                        {' '}
                        · {change.before.confidence ?? '—'} →{' '}
                        {change.after.confidence ?? '—'}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
