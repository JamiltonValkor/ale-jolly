'use client'

import { useTranslations } from 'next-intl'
import { firstLoopSourceUrl } from '../../lib/first-loop-source-url'
import type { FirstLoopArtifact } from '../../types/first-loop.schemas'

function ArtifactSources({
  sources,
}: {
  sources: FirstLoopArtifact['sources']
}) {
  const t = useTranslations('metaAssistant.firstLoop')
  if (!sources.length) return null
  return (
    <ul
      aria-label={t('sourcesTitle')}
      className="mt-4 flex list-disc flex-col gap-2 pl-5 text-sm"
    >
      {sources.map((source, index) => {
        const href = firstLoopSourceUrl(source.url)
        return (
          <li
            key={`${source.url}-${index}`}
            className="text-sa-text-secondary break-words"
          >
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sa-text-link focus-visible:ring-sa-border-focus rounded-sm underline outline-none focus-visible:ring-2"
              >
                {source.title || source.url}
              </a>
            ) : (
              source.title
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ArtifactResult({ artifact }: { artifact: FirstLoopArtifact }) {
  const t = useTranslations('metaAssistant.firstLoop')
  return (
    <details open className="border-sa-border-default rounded-xl border p-4">
      <summary className="text-sa-text-primary focus-visible:ring-sa-border-focus cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-2">
        {artifact.title || t(`stages.${artifact.stage}`)} ·{' '}
        {t('revision', { value: artifact.revision })}
      </summary>
      <p className="text-sa-text-tertiary mt-2 text-xs">
        {t(`stages.${artifact.stage}`)}
      </p>
      <p className="text-sa-text-primary mt-3 text-sm break-words whitespace-pre-wrap">
        {artifact.content}
      </p>
      <ArtifactSources sources={artifact.sources} />
    </details>
  )
}

export function FirstLoopArtifacts({
  artifacts,
}: {
  artifacts: FirstLoopArtifact[]
}) {
  const t = useTranslations('metaAssistant.firstLoop')
  if (artifacts.length === 0) return null
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t('artifactsTitle')}
      data-mask=""
      data-sentry-mask=""
    >
      <h3 className="text-sa-text-primary font-semibold">
        {t('artifactsTitle')}
      </h3>
      {artifacts.map(artifact => (
        <ArtifactResult key={artifact.id} artifact={artifact} />
      ))}
    </section>
  )
}
