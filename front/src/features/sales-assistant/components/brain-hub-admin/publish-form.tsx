'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { SaButton } from '@/shared/components/sa-button'
import { publishRequestSchema, type PublishRequest } from '../../types'

interface Props {
  isPending: boolean
  onSubmit: (input: PublishRequest) => void
  onCancel: () => void
}

const FIELD =
  'bg-sa-surface-elevated border-sa-border-subtle text-sa-text-primary rounded-lg border px-3 py-2 text-sm'

/** Datos del ítem del catálogo que nace de una lección validada. */
export function PublishForm({ isPending, onSubmit, onCancel }: Props) {
  const t = useTranslations('salesAssistant.brainHub.publishForm')
  const [itemId, setItemId] = useState('')
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [invalid, setInvalid] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = publishRequestSchema.safeParse({
      item_id: itemId.trim(),
      name: name.trim(),
      summary: summary.trim() || null,
    })
    setInvalid(!parsed.success)
    if (parsed.success) onSubmit(parsed.data)
  }
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2"
      aria-label={t('title')}
    >
      <label className="text-sa-text-secondary flex flex-col gap-1 text-xs">
        {t('itemId')}
        <input
          value={itemId}
          onChange={event => setItemId(event.target.value)}
          className={FIELD}
        />
      </label>
      <label className="text-sa-text-secondary flex flex-col gap-1 text-xs">
        {t('name')}
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          className={FIELD}
        />
      </label>
      <label className="text-sa-text-secondary flex flex-col gap-1 text-xs">
        {t('summary')}
        <textarea
          value={summary}
          onChange={event => setSummary(event.target.value)}
          rows={2}
          className={FIELD}
        />
      </label>
      {invalid ? (
        <p role="alert" className="text-sa-state-error text-xs">
          {t('invalid')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <SaButton type="submit" size="sm" variant="accent" disabled={isPending}>
          {t('submit')}
        </SaButton>
        <SaButton type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </SaButton>
      </div>
    </form>
  )
}
