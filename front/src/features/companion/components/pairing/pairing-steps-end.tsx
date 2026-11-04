'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Info, Microphone, WarningCircle } from '@phosphor-icons/react'

import { usePairingTransport } from '../../hooks/use-pairing-transport'
import { syncProgress, syncStepStates } from '../../lib/sync-progress'
import { SYNC_STEPS } from '../../types/pairing.schemas'
import { SyncRing } from '../face/sync-ring'
import type { PairingViewProps } from './companion-pairing-view'
import { FlowCompanion, type CompanionMood } from './flow-companion'
import { FlowButton, StepLayout } from './pairing-layout'
import styles from './pairing.module.css'

/** Tres pasos humanos con el progreso real del back; se puede cerrar y sigue solo. */
export function SyncingStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion')
  const states = syncStepStates(props.syncStep, false)
  const business = props.businessName
  return (
    <StepLayout
      visualCentered
      visual={
        <SyncRing
          progress={props.syncStep ? syncProgress(props.syncStep, false) : null}
          label={t('sync.progressLabel')}
        >
          <FlowCompanion
            mood="syncing"
            renderCompanion={props.renderCompanion}
          />
        </SyncRing>
      }
      title={t('flow.syncing.title', { business })}
      description={t('flow.syncing.subtitle')}
      TitleComponent={props.TitleComponent}
      DescriptionComponent={props.DescriptionComponent}
      footer={
        <FlowButton ghost onClick={props.actions.close}>
          {t('flow.syncing.keepInBackground')}
        </FlowButton>
      }
    >
      <ol className={styles.syncSteps}>
        {SYNC_STEPS.map(key => (
          <li key={key} className={styles.syncStep} data-state={states[key]}>
            <span className={styles.mark} aria-hidden="true">
              {states[key] === 'done' ? (
                <Check size={13} weight="bold" />
              ) : null}
              {states[key] === 'active' ? (
                <span className={styles.markActive} />
              ) : null}
            </span>
            <span
              className={states[key] === 'active' ? 'mu-live-text' : undefined}
            >
              {t(`flow.syncing.steps.${key}`, { business })}
            </span>
            <span className="sr-only">
              {t(`sync.stepState.${states[key]}`)}
            </span>
          </li>
        ))}
      </ol>
      {props.syncSlow ? (
        <p role="status" className={styles.notice}>
          <WarningCircle
            size={17}
            weight="light"
            aria-hidden="true"
            className="mt-px shrink-0"
          />
          {t('flow.syncing.slow')}
        </p>
      ) : (
        <p className={styles.note}>
          <Info size={16} weight="light" aria-hidden="true" />
          {t('flow.syncing.background')}
        </p>
      )}
    </StepLayout>
  )
}

/** Celebra al llegar y después queda feliz. */
function useCelebration(): CompanionMood {
  const [mood, setMood] = useState<CompanionMood>('celebrating')
  useEffect(() => {
    const timer = setTimeout(() => setMood('happy'), 2400)
    return () => clearTimeout(timer)
  }, [])
  return mood
}

/**
 * Lo que dice el compañero al terminar (sin voz: no hubo gesto) y al tocar
 * «Probar: dile hola» (con voz: ese toque es el gesto).
 */
function useSuccessLine(props: PairingViewProps) {
  const t = useTranslations('companion.flow.success')
  const business = props.businessName
  if (props.helloNonce > 0) {
    return {
      say: { text: t('helloSays', { business }), nonce: props.helloNonce + 1 },
      voice: true,
    }
  }
  const text = props.ownerFirstName
    ? t('companionSays', { name: props.ownerFirstName, business })
    : t('companionSaysNoName', { business })
  return { say: { text, nonce: 1 }, voice: false }
}

/** «Tu compañero ya conoce {negocio}» y una forma de probarlo ya. */
export function SuccessStep({ props }: { props: PairingViewProps }) {
  const canSayHello = Boolean(usePairingTransport().sayHello)
  const t = useTranslations('companion.flow.success')
  const mood = useCelebration()
  const line = useSuccessLine(props)
  return (
    <StepLayout
      visualCentered
      visual={
        <>
          <span className={styles.bloom} aria-hidden="true" />
          <div className="relative mx-auto w-[132px]">
            <FlowCompanion
              mood={mood}
              say={line.say}
              voice={line.voice}
              renderCompanion={props.renderCompanion}
            />
          </div>
        </>
      }
      title={t('title', { business: props.businessName })}
      description={t('subtitle')}
      TitleComponent={props.TitleComponent}
      DescriptionComponent={props.DescriptionComponent}
      footer={
        <>
          {canSayHello ? (
            <FlowButton
              onClick={props.actions.tryHello}
              className={styles.footStart}
            >
              {t('tryHello')}
            </FlowButton>
          ) : null}
          <FlowButton primary onClick={props.actions.close}>
            {t('done')}
          </FlowButton>
        </>
      }
    >
      {props.device ? (
        <div className={styles.panel}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{props.device.name}</span>
            <span className={styles.rowValue}>
              <span className={`mu-dot ${styles.okDot}`} aria-hidden="true" />
              {t('deviceNow')}
            </span>
          </div>
        </div>
      ) : null}
      {props.tryingHello ? (
        <p role="status" className={styles.tip}>
          <span className={styles.tile}>
            <Microphone size={17} weight="light" aria-hidden="true" />
          </span>
          {t('tryHelloTip')}
        </p>
      ) : null}
    </StepLayout>
  )
}

/** Errores del mundo (sin red, ya tiene dueño): qué pasó + qué hacer. */
export function ErrorStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow')
  const error =
    props.error === 'DEVICE_OFFLINE' || props.error === 'ALREADY_PAIRED'
      ? props.error
      : 'NETWORK'
  return (
    <StepLayout
      visual={
        <FlowCompanion
          mood={error === 'ALREADY_PAIRED' ? 'confused' : 'worried'}
          renderCompanion={props.renderCompanion}
        />
      }
      title={t(`errors.${error}.title`)}
      description={t(`errors.${error}.body`)}
      TitleComponent={props.TitleComponent}
      DescriptionComponent={props.DescriptionComponent}
      footer={
        <>
          <FlowButton
            ghost
            onClick={props.actions.back}
            className={styles.footStart}
          >
            {t('back')}
          </FlowButton>
          <FlowButton
            primary
            busy={props.claiming}
            busyLabel={t('connect.submitting')}
            onClick={props.actions.retry}
          >
            {t(`errors.${error}.action`)}
          </FlowButton>
        </>
      }
    />
  )
}
