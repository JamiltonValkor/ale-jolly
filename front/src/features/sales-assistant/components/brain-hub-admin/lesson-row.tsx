'use client'

import { useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { SaBadge } from '@/shared/components/sa-badge'
import { SaButton } from '@/shared/components/sa-button'
import {
  usePublishLesson,
  useReviewLesson,
} from '../../hooks/use-brain-hub-admin'
import type { AdminLesson } from '../../types'
import { PublishForm } from './publish-form'

interface Props {
  lesson: AdminLesson
}

/** Una lección del buzón con su procedencia y las acciones que permite su estado. */
export function LessonRow({ lesson }: Props) {
  const t = useTranslations('salesAssistant.brainHub')
  const format = useFormatter()
  const review = useReviewLesson()
  const publish = usePublishLesson()
  const [publishing, setPublishing] = useState(false)
  // Candado síncrono: un doble clic no alcanza a ver `isPending` y mandaría dos POST.
  const inFlight = useRef(false)
  const submitPublish = (
    input: Parameters<typeof publish.mutate>[0]['input']
  ) => {
    if (inFlight.current) return
    inFlight.current = true
    publish.mutate(
      { lessonId: lesson.id, input },
      {
        onSettled: () => {
          inFlight.current = false
        },
      }
    )
  }
  const busy = review.isPending || publish.isPending
  return (
    <li className="border-sa-border-subtle flex flex-col gap-2 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SaBadge size="sm" variant="info">
          {lesson.industry_slug}
        </SaBadge>
        <SaBadge size="sm">{t(`provenance.${lesson.provenance}`)}</SaBadge>
        <span className="text-sa-text-tertiary text-xs">
          {format.dateTime(new Date(lesson.created_at), {
            dateStyle: 'medium',
          })}
        </span>
      </div>
      <p className="text-sa-text-primary text-sm">{lesson.text}</p>
      {lesson.status === 'received' ? (
        <div className="flex gap-2">
          <SaButton
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={() =>
              review.mutate({ lessonId: lesson.id, action: 'validate' })
            }
          >
            {t('validate')}
          </SaButton>
          <SaButton
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              review.mutate({ lessonId: lesson.id, action: 'reject' })
            }
          >
            {t('reject')}
          </SaButton>
        </div>
      ) : null}
      {lesson.status === 'validated' && !publishing && !publish.isSuccess ? (
        <SaButton
          size="sm"
          variant="accent"
          className="self-start"
          onClick={() => setPublishing(true)}
        >
          {t('publish')}
        </SaButton>
      ) : null}
      {publishing && !publish.isSuccess ? (
        <PublishForm
          isPending={publish.isPending}
          onCancel={() => setPublishing(false)}
          onSubmit={submitPublish}
        />
      ) : null}
      {publish.isSuccess ? (
        <p role="status" className="text-sa-state-success text-sm">
          {t('published', { version: publish.data.version })}
        </p>
      ) : null}
      {review.isError || publish.isError ? (
        <p role="alert" className="text-sa-state-error text-sm">
          {t('error')}
        </p>
      ) : null}
    </li>
  )
}
