'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { BrainSnapshots } from '../../types'

interface Props {
  items: BrainSnapshots['items']
  version: number
  onChange: (version: number) => void
}

/** Línea de tiempo entre fotos guardadas (la más nueva primero). */
export function BrainTimeline({ items, version, onChange }: Props) {
  const t = useTranslations('salesAssistant.brain')
  const format = useFormatter()
  if (items.length < 2) return null
  return (
    <label className="text-sa-text-secondary flex flex-col gap-1 text-xs">
      {t('timeline')}
      <select
        value={version}
        onChange={event => onChange(Number(event.target.value))}
        className="bg-sa-surface-elevated border-sa-border-subtle text-sa-text-primary rounded-lg border px-3 py-2 text-sm"
      >
        {items.map(item => (
          <option key={item.version} value={item.version}>
            {t('snapshotOption', {
              date: format.dateTime(new Date(item.created_at), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
              nodes: item.node_count,
            })}
          </option>
        ))}
      </select>
    </label>
  )
}
