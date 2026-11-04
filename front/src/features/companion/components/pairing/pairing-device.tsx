'use client'

import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { WarningCircle } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

import type { CompanionDevice } from '../../types/pairing.schemas'
import type { PairingViewProps } from './companion-pairing-view'
import { FlowCompanion } from './flow-companion'
import { FlowButton, StepLayout } from './pairing-layout'
import styles from './pairing.module.css'

/** Visto en los últimos 2 minutos = en línea. */
const ONLINE_WINDOW_MS = 2 * 60_000
/** Cada cuánto se refresca «ahora» para que «en línea» no se quede viejo. */
const NOW_REFRESH_MS = 30_000

/** «Ahora» fuera del render: el que llega por props, o uno propio que se refresca solo. */
function useNow(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now())
  useEffect(() => {
    if (fixed !== undefined) return
    const tick = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS)
    return () => clearInterval(tick)
  }, [fixed])
  return fixed ?? now
}

function DeviceSummary({
  device,
  now,
}: {
  device: CompanionDevice
  now: number
}) {
  const t = useTranslations('companion.flow.device')
  const format = useFormatter()
  const lastSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : null
  const online = lastSeen !== null && now - lastSeen < ONLINE_WINDOW_MS
  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>{t('name')}</span>
        <span className={styles.rowValue}>{device.name}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>{t('since')}</span>
        <span className={styles.rowValue}>
          {format.dateTime(new Date(device.paired_at), {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </span>
      </div>
      {lastSeen !== null ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t('lastSeen')}</span>
          <span className={styles.rowValue}>
            <span
              className={cn('mu-dot', online ? styles.okDot : styles.offDot)}
              aria-hidden="true"
            />
            {online
              ? t('online')
              : format.relativeTime(new Date(lastSeen), now)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** Compañero ya sincronizado: quién es, desde cuándo, cuándo se vio; desvincular pide confirmación. */
export function DeviceStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow.device')
  const device = props.device
  const confirming = props.step === 'confirm-unpair'
  const name = device?.name ?? ''
  const now = useNow(props.now)
  return (
    <StepLayout
      visual={
        <FlowCompanion
          mood={confirming ? 'thinking' : 'idle'}
          renderCompanion={props.renderCompanion}
        />
      }
      title={confirming ? t('confirmTitle', { device: name }) : t('title')}
      description={
        confirming
          ? t('confirmBody')
          : t('subtitle', { business: props.businessName })
      }
      TitleComponent={props.TitleComponent}
      DescriptionComponent={props.DescriptionComponent}
      footer={
        confirming ? (
          <>
            <FlowButton
              ghost
              onClick={props.actions.cancelUnpair}
              className={styles.footStart}
            >
              {t('cancel')}
            </FlowButton>
            <FlowButton
              danger
              busy={props.unpairing}
              busyLabel={t('unpairing')}
              onClick={props.actions.confirmUnpair}
            >
              {t('confirm')}
            </FlowButton>
          </>
        ) : (
          <>
            <FlowButton
              onClick={props.actions.askUnpair}
              className={styles.footStart}
            >
              {t('unpair')}
            </FlowButton>
            <FlowButton primary onClick={props.actions.close}>
              {t('done')}
            </FlowButton>
          </>
        )
      }
    >
      {device && !confirming ? (
        <DeviceSummary device={device} now={now} />
      ) : null}
      {confirming && props.unpairFailed ? (
        <p role="alert" className={styles.notice}>
          <WarningCircle
            size={17}
            weight="light"
            aria-hidden="true"
            className="mt-px shrink-0"
          />
          {t('unpairError')}
        </p>
      ) : null}
    </StepLayout>
  )
}

/** Después de desvincular: qué cambió y cómo volver. */
export function UnpairedStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow')
  return (
    <StepLayout
      visual={
        <FlowCompanion
          mood="idle"
          fallbackState="sleeping"
          renderCompanion={props.renderCompanion}
        />
      }
      title={t('device.unpairedTitle')}
      description={t('device.unpairedBody')}
      TitleComponent={props.TitleComponent}
      DescriptionComponent={props.DescriptionComponent}
      footer={
        <>
          <FlowButton
            ghost
            onClick={props.actions.close}
            className={styles.footStart}
          >
            {t('device.done')}
          </FlowButton>
          <FlowButton primary onClick={props.actions.pairAgain}>
            {t('device.pairAgain')}
          </FlowButton>
        </>
      }
    />
  )
}
