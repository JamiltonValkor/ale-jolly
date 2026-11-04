'use client'

import { useTranslations } from 'next-intl'
import type { StockShare } from '../../../types'
import styles from './stock.module.css'

export interface StockShareOption {
  variante_id: string
  nombre: string
}

/** Lo que la dueña escribió por variante, como texto del campo. */
export type StockShareDraft = Record<string, string>

const WHOLE = /^\d+$/

/**
 * R15: el reparto solo existe si la dueña escribió cada cantidad y suman el
 * total. Nunca se completa ni se reparte en proporción.
 */
export function shareOf(
  draft: StockShareDraft,
  options: StockShareOption[],
  total: number
): StockShare[] | null {
  if (options.length < 2) return null
  const values = options.map(option => draft[option.variante_id]?.trim() ?? '')
  if (!values.every(value => WHOLE.test(value))) return null
  const shares = options.map((option, index) => ({
    variante_id: option.variante_id,
    contado: Number(values[index]),
  }))
  const sum = shares.reduce((acc, share) => acc + share.contado, 0)
  return sum === total ? shares : null
}

export function shareSum(draft: StockShareDraft) {
  return Object.values(draft)
    .filter(value => WHOLE.test(value.trim()))
    .reduce((acc, value) => acc + Number(value), 0)
}

interface Props {
  total: number
  options: StockShareOption[]
  draft: StockShareDraft
  onChange: (draft: StockShareDraft) => void
}

/** Un campo por variante y la suma contra el total que vio Jolly. */
export function StockSharePicker({ total, options, draft, onChange }: Props) {
  const t = useTranslations('metaExperience.stock.share')
  if (options.length < 2)
    return (
      <p role="status" className={styles.notice}>
        {t('noOptions')}
      </p>
    )
  const sum = shareSum(draft)
  const fits = sum === total
  return (
    <fieldset className={styles.share}>
      <legend>{t('legend', { total })}</legend>
      {options.map(option => (
        <label key={option.variante_id} className={styles.shareRow}>
          <span>{option.nombre}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={draft[option.variante_id] ?? ''}
            onChange={event =>
              onChange({ ...draft, [option.variante_id]: event.target.value })
            }
          />
        </label>
      ))}
      <p aria-live="polite" className={fits ? styles.shareOk : styles.shareSum}>
        {t(fits ? 'fits' : 'sum', { sum, total })}
      </p>
    </fieldset>
  )
}
