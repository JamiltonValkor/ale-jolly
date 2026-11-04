'use client'

import { useTranslations } from 'next-intl'
import { ListChecks } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { CompanionStage } from './companion-stage'
import type { RenderCompanion } from './types'
import styles from './meta-today.module.css'

interface Props {
  /** Tu asistente trabajando; sin él queda el ícono. */
  renderCompanion?: RenderCompanion
  className?: string
}

/** «Actividad» vacía: tu asistente ya trabaja y aquí va a contar qué cambió. */
export function MetaActivityEmpty({ renderCompanion, className }: Props) {
  const t = useTranslations('metaExperience.team.activityEmpty')
  const tCompanion = useTranslations('metaExperience.companion')
  return (
    <div className={cn(styles.empty, className)}>
      {renderCompanion ? (
        <CompanionStage
          size="card"
          mood="working"
          label={tCompanion('label')}
          interactive
          renderCompanion={renderCompanion}
        />
      ) : (
        <span className="mu-tile" aria-hidden>
          <ListChecks size={17} weight="light" />
        </span>
      )}
      <h3 className={styles.emptyTitle}>{t('title')}</h3>
      <p className={styles.emptyBody}>{t('body')}</p>
    </div>
  )
}
