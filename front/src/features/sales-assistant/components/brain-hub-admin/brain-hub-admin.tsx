'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SaButton } from '@/shared/components/sa-button'
import {
  useAdminCatalog,
  useAdminLessons,
  useRetireCatalogItem,
} from '../../hooks/use-brain-hub-admin'
import { SalesAssistantClientError } from '../../sdk/sales-assistant-client'
import { LESSON_STATUSES, type AdminLessons } from '../../types'
import { LessonRow } from './lesson-row'

const FIELD =
  'bg-sa-surface-elevated border-sa-border-subtle text-sa-text-primary rounded-lg border px-3 py-2 text-sm'

function isDenied(error: unknown): boolean {
  return (
    error instanceof SalesAssistantClientError &&
    (error.status === 403 || error.status === 404)
  )
}

function Lessons({ lessons }: { lessons: AdminLessons['lessons'] }) {
  const t = useTranslations('salesAssistant.brainHub')
  const statusLabel = useTranslations('salesAssistant.sharing.lessonStatus')
  const [status, setStatus] = useState('received')
  const [industry, setIndustry] = useState('')
  const industries = [
    ...new Set(lessons.map(lesson => lesson.industry_slug)),
  ].sort()
  const visible = lessons.filter(
    l =>
      (!status || l.status === status) &&
      (!industry || l.industry_slug === industry)
  )
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <label className="text-sa-text-secondary flex flex-col gap-1 text-xs">
          {t('filters.status')}
          <select
            value={status}
            onChange={event => setStatus(event.target.value)}
            className={FIELD}
          >
            <option value="">{t('filters.all')}</option>
            {LESSON_STATUSES.map(value => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sa-text-secondary flex flex-col gap-1 text-xs">
          {t('filters.industry')}
          <select
            value={industry}
            onChange={event => setIndustry(event.target.value)}
            className={FIELD}
          >
            <option value="">{t('filters.all')}</option>
            {industries.map(value => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {visible.length ? (
        <ul className="flex flex-col gap-2">
          {visible.map(lesson => (
            <LessonRow key={lesson.id} lesson={lesson} />
          ))}
        </ul>
      ) : (
        <p className="text-sa-text-tertiary text-sm">{t('lessonsEmpty')}</p>
      )}
    </section>
  )
}

function Catalog() {
  const t = useTranslations('salesAssistant.brainHub')
  const catalog = useAdminCatalog()
  const retire = useRetireCatalogItem()
  const items = catalog.data?.items ?? []
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sa-text-primary text-lg font-semibold">
        {t('catalogTitle')}
      </h2>
      {catalog.isSuccess && !items.length ? (
        <p className="text-sa-text-tertiary text-sm">{t('catalogEmpty')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map(item => (
          <li
            key={item.id}
            className="border-sa-border-subtle flex items-center gap-3 rounded-xl border p-3"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sa-text-primary text-sm font-medium">
                {item.name}
              </span>
              <span className="text-sa-text-tertiary text-xs">{`${item.id} · ${item.version} · ${item.industry_slug ?? '—'}`}</span>
            </div>
            <SaButton
              size="sm"
              variant="outline"
              disabled={retire.isPending}
              onClick={() => retire.mutate(item.id)}
            >
              {t('retire')}
            </SaButton>
          </li>
        ))}
      </ul>
      {retire.isError ? (
        <p role="alert" className="text-sa-state-error text-sm">
          {t('error')}
        </p>
      ) : null}
    </section>
  )
}

/** Buzón del Cerebro SaleADS (OSF-005). Sin lista blanca propia: ante 403/404, «no disponible». */
export function BrainHubAdmin() {
  const t = useTranslations('salesAssistant.brainHub')
  const lessons = useAdminLessons()
  if (lessons.isPending)
    return (
      <p role="status" className="text-sa-text-secondary p-6 text-sm">
        {t('loading')}
      </p>
    )
  if (lessons.isError) {
    return (
      <p role="alert" className="text-sa-text-secondary p-6 text-sm">
        {t(isDenied(lessons.error) ? 'unavailable' : 'error')}
      </p>
    )
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-sa-text-primary text-2xl font-semibold">
          {t('title')}
        </h1>
        <p className="text-sa-text-secondary text-sm">{t('subtitle')}</p>
      </div>
      <Lessons lessons={lessons.data.lessons} />
      <Catalog />
    </div>
  )
}
