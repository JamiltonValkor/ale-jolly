'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { SnapshotItem } from './types'
import styles from './meta-brain.module.css'

interface PickerProps {
  snapshots: SnapshotItem[]
  version: number | null
  onVersionChange?: (version: number) => void
  className?: string
}

/** «Fotos guardadas»: ver el cerebro como estaba en una foto anterior. */
export function SnapshotPicker({
  snapshots,
  version,
  onVersionChange,
  className,
}: PickerProps) {
  const t = useTranslations('metaBrain.photos')
  const format = useFormatter()
  if (snapshots.length < 2) return null
  return (
    <label className={cn(styles.inlineField, className)}>
      <span className="mu-label">{t('label')}</span>
      <select
        className={styles.select}
        value={version ?? ''}
        onChange={event => onVersionChange?.(Number(event.target.value))}
      >
        {snapshots.map(item => (
          <option key={item.version} value={item.version}>
            {t('option', {
              date: format.dateTime(new Date(item.created_at), {
                day: 'numeric',
                month: 'short',
              }),
              count: item.node_count,
            })}
          </option>
        ))}
      </select>
    </label>
  )
}
