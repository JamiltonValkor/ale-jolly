'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type {
  FirstLoopTask,
  FirstLoopWork,
} from '../../types/first-loop.schemas'
import { FirstLoopArtifacts } from './first-loop-artifacts'
import { FirstLoopComposer } from './first-loop-composer'

const PROFILES = [
  'investigador',
  'estratega',
  'estructurador',
  'analista',
  'optimizador',
] as const

function TeamProgress({ tasks }: { tasks: FirstLoopTask[] }) {
  const t = useTranslations('metaAssistant.firstLoop')
  return (
    <ol aria-label={t('teamTitle')} className="grid gap-3 sm:grid-cols-2">
      {PROFILES.map(profile => {
        const assigned = tasks.filter(task => task.profile === profile)
        return (
          <li
            key={profile}
            className="border-sa-border-default flex flex-col gap-2 rounded-xl border p-4"
          >
            <h4 className="text-sa-text-primary font-medium">
              {t(`profiles.${profile}`)}
            </h4>
            {assigned.length === 0 ? (
              <p className="text-sa-text-tertiary text-sm">
                {t('taskStatus.unassigned')}
              </p>
            ) : (
              assigned.map(task => (
                <div key={task.id} className="flex flex-col gap-1">
                  <p className="text-sa-text-secondary text-sm">{task.title}</p>
                  <p className="text-sa-text-tertiary text-xs">
                    {t('revision', { value: task.revision })} ·{' '}
                    {t(
                      `taskStatus.${task.status === 'completed' && !task.execution_verified ? 'unverified' : task.status}`
                    )}
                  </p>
                </div>
              ))
            )}
          </li>
        )
      })}
    </ol>
  )
}

interface Props {
  work: FirstLoopWork
  busy: boolean
  onFeedback: (text: string, revision: number) => Promise<boolean>
}

function WorkStatus({ work }: { work: FirstLoopWork }) {
  const t = useTranslations('metaAssistant.firstLoop')
  const format = useFormatter()
  const fresh = work.projection.status === 'fresh'
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sa-text-primary font-semibold">{t('teamTitle')}</h3>
      <p className="text-sa-text-secondary text-sm">
        {t(`workStatus.${work.status}`)}
      </p>
      {!fresh && (
        <p role="status" className="text-sa-state-warning text-sm">
          {t(`projection.${work.projection.status}`)}
        </p>
      )}
      {work.projection.observed_at && (
        <p className="text-sa-text-tertiary text-xs">
          {t('observedAt', {
            value: format.dateTime(new Date(work.projection.observed_at), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      )}
    </div>
  )
}

export function FirstLoopWorkView({ work, busy, onFeedback }: Props) {
  const t = useTranslations('metaAssistant.firstLoop')
  const fresh = work.projection.status === 'fresh'
  const canReview =
    fresh &&
    work.delivery === 'available' &&
    work.artifacts.some(artifact => artifact.revision === work.revision) &&
    ['awaiting_feedback', 'completed'].includes(work.status)
  return (
    <section
      className="flex flex-col gap-5"
      aria-label={t('teamTitle')}
      data-mask=""
      data-sentry-mask=""
    >
      <WorkStatus work={work} />
      <TeamProgress tasks={work.tasks} />
      <FirstLoopArtifacts artifacts={work.artifacts} />
      {work.feedback_count > 0 && (
        <p className="text-sa-text-secondary text-sm">
          {t('feedbackReceived', { count: work.feedback_count })}
        </p>
      )}
      {canReview && (
        <FirstLoopComposer
          key={`${work.work_id}/${work.revision}`}
          mode="feedback"
          busy={busy}
          onSend={text => onFeedback(text, work.revision)}
        />
      )}
    </section>
  )
}
