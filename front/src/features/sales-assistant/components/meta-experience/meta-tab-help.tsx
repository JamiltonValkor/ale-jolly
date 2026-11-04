'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, Check, Question } from '@phosphor-icons/react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'
import { cn } from '@/lib/utils'
import { MetaGuideDialog } from './meta-help'
import type { CompanionMood, MetaTab, RenderFace } from './types'
import styles from './meta-experience.module.css'

const MOOD: Record<MetaTab, CompanionMood> = {
  today: 'idle',
  chat: 'speaking',
  brain: 'thinking',
  limits: 'idle',
  activity: 'working',
  stock: 'working',
}
const LIMIT_POINTS = ['spend', 'credits', 'asks'] as const

interface Props {
  tab: MetaTab
  businessName: string | null
  /** Pestañas visibles, para el texto de los atajos. */
  tabCount?: number
  renderFace?: RenderFace
  className?: string
}

/**
 * El «?» de la pestaña actual: tu asistente explica en su voz qué es y cómo
 * leerla, en vez de repetir un título y una frase dentro de cada pestaña.
 * Desde ahí se llega a «Cómo funciona» con los atajos.
 */
export function MetaTabHelp({
  tab,
  businessName,
  tabCount,
  renderFace,
  className,
}: Props) {
  const t = useTranslations('metaExperience')
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [guide, setGuide] = useState(false)
  const business = businessName ?? t('start.yourBusiness')
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn('mu-btn mu-btn-ghost mu-btn-icon', className)}
            aria-label={t('tabHelp.button', { tab: t(`tabs.${tab}`) })}
          >
            <Question size={18} weight="light" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={10}
          aria-labelledby={titleId}
          data-meta-ui=""
          className={cn(META_UI_FONT_CLASS, styles.help)}
        >
          <div className={styles.helpHead}>
            {renderFace ? (
              <span className={styles.helpFace} aria-hidden>
                {renderFace({
                  mood: MOOD[tab],
                  size: 40,
                  label: t('companion.label'),
                })}
              </span>
            ) : null}
            <p id={titleId} className={styles.helpTitle}>
              {t(`tabHelp.${tab}.title`)}
            </p>
          </div>
          <p className={styles.helpBody}>
            {t(`tabHelp.${tab}.body`, { business })}
          </p>
          {tab === 'limits' ? (
            <ul className={styles.helpPoints}>
              {LIMIT_POINTS.map(point => (
                <li key={point}>
                  <Check size={13} weight="bold" aria-hidden />
                  {t(`tabHelp.limits.points.${point}`)}
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className={styles.helpGuide}
            onClick={() => {
              setOpen(false)
              setGuide(true)
            }}
          >
            {t('tabHelp.guide')}
            <ArrowRight size={14} weight="bold" aria-hidden />
          </button>
        </PopoverContent>
      </Popover>
      <MetaGuideDialog
        open={guide}
        onOpenChange={setGuide}
        tabCount={tabCount}
      />
    </>
  )
}
