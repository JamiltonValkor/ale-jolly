'use client'

import { useTranslations } from 'next-intl'
import {
  ArrowsLeftRight,
  Brain,
  Check,
  ChatCircleDots,
  QrCode,
  Storefront,
  WifiHigh,
  WarningCircle,
} from '@phosphor-icons/react'

import { isValidPairingCode, PAIRING_CODE_LENGTH } from '../../lib/pairing-code'
import { CompanionFace } from '../face/companion-face'
import { CodeInput } from './code-input'
import type { PairingViewProps } from './companion-pairing-view'
import { FlowCompanion } from './flow-companion'
import { FlowButton, StepLayout } from './pairing-layout'
import styles from './pairing.module.css'

/** «Tu asistente, ahora a tu lado»: qué cambia y qué necesita, antes de pedir nada. */
export function IntroStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow.intro')
  const changes = [
    { icon: Brain, text: t('changes.knows', { business: props.businessName }) },
    { icon: ChatCircleDots, text: t('changes.talks') },
    { icon: ArrowsLeftRight, text: t('changes.control') },
  ]
  return (
    <StepLayout
      visual={
        <FlowCompanion mood="idle" renderCompanion={props.renderCompanion} />
      }
      title={t('title')}
      description={t('subtitle')}
      TitleComponent={props.TitleComponent}
      DescriptionComponent={props.DescriptionComponent}
      footer={
        <>
          <FlowButton ghost onClick={props.actions.close}>
            {t('later')}
          </FlowButton>
          <FlowButton primary onClick={props.actions.start}>
            {t('start')}
          </FlowButton>
        </>
      }
    >
      <div className={styles.section}>
        <span className={styles.label}>{t('changesLabel')}</span>
        {changes.map(({ icon: Icon, text }) => (
          <div key={text} className={styles.row}>
            <span className={styles.tile}>
              <Icon size={17} weight="light" aria-hidden="true" />
            </span>
            {text}
          </div>
        ))}
      </div>
      <div className={styles.section}>
        <span className={styles.label}>{t('needsLabel')}</span>
        <div className={styles.row}>
          <span className={styles.tile}>
            <WifiHigh size={17} weight="light" aria-hidden="true" />
          </span>
          {t('needs')}
        </div>
      </div>
    </StepLayout>
  )
}

function FieldMessage({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow.connect')
  const inline =
    props.error === 'INVALID_CODE' ||
    props.error === 'EXPIRED' ||
    props.error === 'RATE_LIMITED'
  if (inline || props.forbiddenTyped) {
    return (
      <p
        id="companion-code-message"
        role="alert"
        className={styles.fieldMessage}
        data-tone="error"
      >
        <WarningCircle size={16} weight="light" aria-hidden="true" />
        {props.forbiddenTyped && !inline
          ? t('errors.invalidChar')
          : t(`errors.${props.error ?? 'INVALID_CODE'}`)}
      </p>
    )
  }
  const remaining = PAIRING_CODE_LENGTH - props.code.length
  return (
    <p
      id="companion-code-message"
      aria-live="polite"
      className={styles.fieldMessage}
      data-tone={remaining === 0 ? 'ok' : undefined}
    >
      {remaining === 0 ? (
        <Check size={16} weight="bold" aria-hidden="true" />
      ) : null}
      {remaining === 0
        ? t('complete')
        : props.code.length > 0
          ? t('remaining', { count: remaining })
          : t('hint')}
    </p>
  )
}

/** Escribir (o confirmar el del QR) el código de 6 caracteres. */
export function ConnectStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow')
  const valid = isValidPairingCode(props.code)
  const inlineError =
    props.error === 'INVALID_CODE' ||
    props.error === 'EXPIRED' ||
    props.error === 'RATE_LIMITED'
  return (
    <StepLayout
      visual={
        <FlowCompanion
          mood={props.claiming ? 'thinking' : 'listening'}
          renderCompanion={props.renderCompanion}
        />
      }
      title={t('connect.title')}
      description={
        props.codeFromQr ? t('connect.subtitleFromQr') : t('connect.subtitle')
      }
      focusTitle={false}
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
            disabled={!valid}
            busy={props.claiming}
            busyLabel={t('connect.submitting')}
            onClick={props.actions.submitCode}
          >
            {props.needsBusiness
              ? t('connect.chooseBusiness')
              : t('connect.submit')}
          </FlowButton>
        </>
      }
    >
      <div className="grid gap-3">
        {props.codeFromQr ? (
          <span className="mu-chip justify-self-start">
            <QrCode size={14} weight="light" aria-hidden="true" />
            {t('connect.fromQr')}
          </span>
        ) : null}
        <CodeInput
          value={props.code}
          onChange={props.actions.changeCode}
          onSubmit={props.actions.submitCode}
          label={t('connect.inputLabel')}
          invalid={inlineError || props.forbiddenTyped}
          describedBy="companion-code-message"
        />
        <FieldMessage props={props} />
      </div>
      <div className="grid gap-2">
        <span className={styles.label}>{t('connect.previewLabel')}</span>
        <div className={styles.preview} aria-hidden="true">
          <span className={styles.previewFace}>
            <CompanionFace state="idle" decorative />
          </span>
          <span className={styles.previewText}>
            <span className={styles.previewTitle}>
              {t('connect.previewTitle')}
            </span>
            <span className={styles.previewCode}>•••·•••</span>
          </span>
        </div>
      </div>
      {!props.needsBusiness ? (
        <p className={styles.note}>
          <Storefront size={16} weight="light" aria-hidden="true" />
          {t('connect.businessNote', { business: props.businessName })}
        </p>
      ) : null}
      {props.device ? (
        <p className={styles.note}>
          <ArrowsLeftRight size={16} weight="light" aria-hidden="true" />
          {t('connect.replaceNote', { device: props.device.name })}
        </p>
      ) : null}
    </StepLayout>
  )
}

/** Solo con más de un negocio: cuál va a conocer (por defecto, el abierto). */
export function BusinessStep({ props }: { props: PairingViewProps }) {
  const t = useTranslations('companion.flow')
  return (
    <StepLayout
      visual={
        <FlowCompanion
          mood="thinking"
          renderCompanion={props.renderCompanion}
        />
      }
      title={t('business.title')}
      description={t('business.subtitle')}
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
            disabled={!props.businessId}
            busy={props.claiming}
            busyLabel={t('connect.submitting')}
            onClick={props.actions.submitCode}
          >
            {t('business.submit')}
          </FlowButton>
        </>
      }
    >
      <fieldset className={styles.choices}>
        <legend className="sr-only">{t('business.listLabel')}</legend>
        {props.businesses.map(business => (
          <label key={business.id} className={styles.choice}>
            <input
              type="radio"
              name="companion-business"
              value={business.id}
              checked={props.businessId === business.id}
              onChange={() => props.actions.chooseBusiness(business.id)}
            />
            <span className={styles.tile}>
              <Storefront size={17} weight="light" aria-hidden="true" />
            </span>
            <span className="flex-1 text-[14.5px] font-medium">
              {business.name}
            </span>
            {props.defaultBusinessId === business.id ? (
              <span className="mu-chip">{t('business.current')}</span>
            ) : null}
            <span className={styles.radio} aria-hidden="true">
              {props.businessId === business.id ? (
                <Check size={12} weight="bold" />
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
    </StepLayout>
  )
}
