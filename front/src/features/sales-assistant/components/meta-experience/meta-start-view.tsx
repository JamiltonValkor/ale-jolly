'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowsClockwise,
  Brain,
  ShieldCheck,
  Sparkle,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { startMood } from '../../lib/meta-experience/choreography'
import { BUSINESS_TYPES, type BusinessType } from '../../types/orqa.schemas'
import { CompanionStage } from './companion-stage'
import type { CompanionActionRequest, RenderCompanion } from './types'
import styles from './meta-screens.module.css'

const POINTS: { key: 'knows' | 'loop' | 'limits'; icon: Icon }[] = [
  { key: 'knows', icon: Brain },
  { key: 'loop', icon: ArrowsClockwise },
  { key: 'limits', icon: ShieldCheck },
]

export interface MetaStartViewProps {
  businessName: string | null
  type: BusinessType | null
  prefilled: boolean
  onChooseType: (type: BusinessType) => void
  onActivate: () => void
  busy: boolean
  errorMessage: string | null
  renderCompanion?: RenderCompanion
  className?: string
}

/**
 * Llegada (sin asistente): la promesa en una frase, qué hace en tres filas,
 * el tipo de negocio (precargado si Saleads ya lo sabe) y un solo botón.
 */
export function MetaStartView({
  businessName,
  type,
  prefilled,
  onChooseType,
  onActivate,
  busy,
  errorMessage,
  renderCompanion,
  className,
}: MetaStartViewProps) {
  const t = useTranslations('metaExperience')
  const tType = useTranslations('salesAssistant.businessType.options')
  const name = useId()
  const business = businessName ?? t('start.yourBusiness')
  const needsChoice = businessName !== null && type === null
  const blocked = busy || needsChoice
  // Al acercarse al botón, el compañero abre un ojo; al elegir el tipo, asiente.
  const [nearCta, setNearCta] = useState(false)
  const [gesture, setGesture] = useState<CompanionActionRequest | null>(null)
  const choose = (option: BusinessType) => {
    onChooseType(option)
    setGesture(prev => ({ name: 'nod', nonce: (prev?.nonce ?? 0) + 1 }))
  }
  return (
    <section
      className={cn(styles.hero, className)}
      aria-labelledby={`${name}-title`}
    >
      <CompanionStage
        size="hero"
        mood={startMood({ busy, nearCta })}
        label={t('companion.sleeping')}
        action={gesture}
        interactive
        renderCompanion={renderCompanion}
      />
      <div className={styles.heroCopy}>
        <h2 id={`${name}-title`} className={styles.heroTitle}>
          {businessName
            ? t('start.title', { business: businessName })
            : t('start.titleNoBusiness')}
        </h2>
        <p className={styles.lead}>{t('start.lead')}</p>
        <ul className={cn('mu-card', styles.points)}>
          {POINTS.map(({ key, icon: PointIcon }) => (
            <li key={key} className="mu-row">
              <span className="mu-tile" aria-hidden>
                <PointIcon size={17} weight="light" />
              </span>
              <div>
                <p className={styles.rowTitle}>
                  {t(`start.points.${key}.title`)}
                </p>
                <p className={styles.rowBody}>
                  {t(`start.points.${key}.body`, { business })}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {businessName ? (
          <fieldset className={styles.fieldset} disabled={busy}>
            <legend className={styles.legend}>
              {t('start.typeQuestion', { business: businessName })}
            </legend>
            {prefilled ? (
              <p className={styles.hint}>{t('start.typePrefilled')}</p>
            ) : null}
            <div className={styles.options}>
              {BUSINESS_TYPES.map(option => (
                <label key={option} className={styles.option}>
                  <input
                    type="radio"
                    name={`${name}-type`}
                    value={option}
                    checked={type === option}
                    onChange={() => choose(option)}
                  />
                  <span aria-hidden className={styles.radioMark} />
                  {tType(`${option}.title`)}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className={styles.ctaRow}>
          <button
            type="button"
            className="mu-btn mu-btn-p mu-btn-lg"
            onClick={blocked ? undefined : onActivate}
            onPointerEnter={() => setNearCta(true)}
            onPointerLeave={() => setNearCta(false)}
            onFocus={() => setNearCta(true)}
            onBlur={() => setNearCta(false)}
            aria-disabled={blocked || undefined}
            aria-busy={busy || undefined}
            aria-describedby={needsChoice ? `${name}-why` : undefined}
          >
            <Sparkle size={17} weight="light" aria-hidden />
            {busy ? t('start.ctaBusy') : t('start.cta')}
          </button>
          <p id={`${name}-why`} className={styles.note}>
            {needsChoice ? t('start.chooseTypeFirst') : t('start.time')}
          </p>
        </div>
        {errorMessage ? (
          <p role="alert" className={styles.alert}>
            {errorMessage}
          </p>
        ) : null}
        <p className={styles.terms}>{t('start.terms')}</p>
      </div>
    </section>
  )
}
