'use client'

import { useTranslations } from 'next-intl'
import {
  ArrowsClockwise,
  Check,
  MapPin,
  Power,
  WifiHigh,
} from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

import type { FaceState } from '../../lib/face-state'
import { syncProgress, syncStepStates } from '../../lib/sync-progress'
import { SYNC_STEPS, type SyncStep } from '../../types/pairing.schemas'
import { CompanionFace, type SayLine } from '../face/companion-face'
import { SyncRing } from '../face/sync-ring'
import { RobotIsotype, RobotTopbar } from './robot-chrome'
import styles from './robot-screen.module.css'

/** Al encender: el isotipo iridiscente y el nombre «Meta Assistant». */
export function RobotBootPanel() {
  const t = useTranslations('companion')
  return (
    <div className={cn(styles.panel, styles.boot)}>
      <div className={styles.bootMark}>
        <span className={styles.isoGlow} aria-hidden="true">
          <RobotIsotype />
        </span>
        <RobotIsotype />
      </div>
      <h1 className={styles.bootName}>
        {t('brand.product')}
        <span className={styles.bootBy}>{t('brand.by')}</span>
      </h1>
      <p role="status" className={styles.bootStatus}>
        <span className="mu-live-text">{t('robot.boot.status')}</span>
      </p>
    </div>
  )
}

interface SyncProps {
  step: SyncStep | null
  businessName: string | null
  plateColor?: string
}

/** Concentrado: los ojos siguen la luz y el anillo se llena con los pasos reales. */
export function RobotSyncPanel({ step, businessName, plateColor }: SyncProps) {
  const t = useTranslations('companion')
  const states = syncStepStates(step, false)
  return (
    <div className={cn(styles.panel, styles.split, styles.two)}>
      <RobotTopbar status={t('robot.syncing.status')} tone="live" />
      <SyncRing
        className={styles.ringWrap}
        progress={syncProgress(step, false)}
        label={t('sync.progressLabel')}
      >
        <CompanionFace state="syncing" plateColor={plateColor} />
      </SyncRing>
      <div className={styles.copy}>
        <h1 className={styles.title}>
          {businessName
            ? t('robot.syncing.title', { business: businessName })
            : t('robot.syncing.titleNoBusiness')}
        </h1>
        <ol className={styles.steps}>
          {SYNC_STEPS.map(key => (
            <li key={key} className={styles.step} data-state={states[key]}>
              <span className={styles.stepMark} aria-hidden="true">
                {states[key] === 'done' ? (
                  <Check size="0.85em" weight="bold" />
                ) : null}
                {states[key] === 'active' ? (
                  <span className={styles.stepActive} />
                ) : null}
              </span>
              <span>{t(`robot.syncing.steps.${key}`)}</span>
              <span className="sr-only">
                {t(`sync.stepState.${states[key]}`)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

interface PairedProps {
  ownerFirstName: string | null
  businessName: string | null
  plateColor?: string
}

/** «¡Hola, {nombre}! Ya conozco {negocio}.» Celebra con medida. */
export function RobotPairedPanel({
  ownerFirstName,
  businessName,
  plateColor,
}: PairedProps) {
  const t = useTranslations('companion.robot.paired')
  return (
    <div className={cn(styles.panel, styles.paired)}>
      <RobotTopbar status={t('status')} tone="ok" />
      <div className={styles.faceWrap}>
        <span className={styles.bloom} aria-hidden="true" />
        <CompanionFace state="happy" plateColor={plateColor} />
      </div>
      <div className={styles.copy}>
        <h1 className={styles.greeting}>
          {ownerFirstName
            ? t('greeting', { name: ownerFirstName })
            : t('greetingNoName')}
        </h1>
        <p className={styles.lead}>
          {businessName
            ? t('knows', { business: businessName })
            : t('knowsNoBusiness')}
        </p>
      </div>
    </div>
  )
}

/** En vivo: solo la cara, a pantalla completa (se abre desde donde estaba). */
export function RobotLivePanel({
  face,
  say,
  amplitude,
  plateColor,
}: {
  face: FaceState
  say?: SayLine
  amplitude?: number
  plateColor?: string
}) {
  return (
    <div className={cn(styles.panel, styles.live)}>
      <CompanionFace
        fit="bleed"
        state={face}
        say={say}
        amplitude={amplitude}
        plateColor={plateColor}
      />
    </div>
  )
}

interface OfflineProps {
  retryInSeconds: number | null
  onRetry?: () => void
  plateColor?: string
}

const CHECKS = [
  { key: 'router', icon: Power },
  { key: 'near', icon: MapPin },
  { key: 'network', icon: WifiHigh },
] as const

/** Sin internet: qué revisar, cuándo reintenta solo y un botón para no esperar. */
export function RobotOfflinePanel({
  retryInSeconds,
  onRetry,
  plateColor,
}: OfflineProps) {
  const t = useTranslations('companion.robot.offline')
  return (
    <div className={cn(styles.panel, styles.split, styles.two)}>
      <RobotTopbar status={t('status')} tone="warn" />
      <div className={styles.faceWrap}>
        <CompanionFace state="error" plateColor={plateColor} />
      </div>
      <div className={styles.copy}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.lead}>{t('body')}</p>
        <ul className={styles.checks}>
          {CHECKS.map(({ key, icon: Icon }) => (
            <li key={key}>
              <Icon size="1.1em" weight="light" aria-hidden="true" />
              {t(`checks.${key}`)}
            </li>
          ))}
        </ul>
        <div className={styles.retryRow}>
          <span aria-live="polite">
            {retryInSeconds === null
              ? t('retrying')
              : t('retryIn', { seconds: retryInSeconds })}
          </span>
          {onRetry ? (
            <button
              type="button"
              className={styles.retryButton}
              onClick={onRetry}
            >
              <ArrowsClockwise
                size="1em"
                weight="light"
                aria-hidden="true"
                className="mr-[0.4em] inline"
              />
              {t('retryNow')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
