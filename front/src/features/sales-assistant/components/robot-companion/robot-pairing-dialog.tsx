'use client'

import { useId, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle, Robot } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { SaModal } from '@/shared/components/sa-modal'
import { cn } from '@/lib/utils'
import {
  useClaimRobotDeviceMutation,
  useRobotDevices,
} from '../../hooks/use-robot-devices'
import {
  formatRobotPairingCode,
  isCompleteRobotPairingCode,
  isRobotChannelUnavailable,
  robotClaimErrorKey,
} from '../../lib/robot-pairing-code'
import { RobotDevicesList } from './robot-devices-list'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Código del QR (`?code=`): llega puesto y el botón queda enfocado. */
  initialCode?: string
}

function PairedView({ name, onDone }: { name: string; onDone: () => void }) {
  const t = useTranslations('metaAssistant.robotCompanion')
  return (
    <div role="status" className="flex flex-col items-center text-center">
      <span
        aria-hidden="true"
        className="bg-sa-state-success-bg text-sa-state-success relative flex size-16 items-center justify-center rounded-full motion-safe:animate-[pulse_1.6s_ease-out_1]"
      >
        <CheckCircle weight="fill" className="size-9" />
      </span>
      <p className="text-sa-text-primary mt-4 text-lg font-semibold">
        {t('success.title', { name })}
      </p>
      <p className="text-sa-text-secondary mt-1 text-sm">
        {t('success.description')}
      </p>
      <SaButton
        variant="primary"
        size="lg"
        className="w-full"
        containerClassName="mt-6 w-full"
        onClick={onDone}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- única acción tras vincular
        autoFocus
      >
        {t('success.done')}
      </SaButton>
    </div>
  )
}

function ClaimForm({
  initialCode,
  disabled,
  onPaired,
}: {
  initialCode: string
  disabled: boolean
  onPaired: (name: string) => void
}) {
  const t = useTranslations('metaAssistant.robotCompanion')
  const claim = useClaimRobotDeviceMutation()
  const [code, setCode] = useState(initialCode)
  const inputId = useId()
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`
  const complete = isCompleteRobotPairingCode(code)
  const error = claim.error
    ? t(`errors.${robotClaimErrorKey(claim.error)}`)
    : null

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!complete || claim.isPending || disabled) return
    claim.mutate(code, { onSuccess: data => onPaired(data.device_name) })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={inputId}
          className="text-sa-text-secondary text-sm font-medium"
        >
          {t('form.label')}
        </label>
        <input
          id={inputId}
          value={code}
          onChange={event => {
            if (claim.error) claim.reset()
            setCode(formatRobotPairingCode(event.target.value))
          }}
          placeholder="XXXX-XXXX"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={20}
          disabled={disabled || claim.isPending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- el modal existe para escribir el código
          autoFocus={!initialCode}
          className={cn(
            'bg-sa-surface-card border-sa-border-default text-sa-text-primary placeholder:text-sa-text-muted h-14 w-full rounded-2xl border text-center font-mono text-2xl tracking-[0.3em] uppercase outline-none',
            'focus-visible:border-sa-border-focus focus-visible:ring-sa-border-focus/20 focus-visible:ring-4',
            'disabled:opacity-60',
            error &&
              'border-sa-state-error focus-visible:border-sa-state-error focus-visible:ring-sa-state-error/20'
          )}
        />
        <p id={hintId} className="text-sa-text-tertiary text-xs">
          {t('form.hint')}
        </p>
        {error && (
          <p id={errorId} role="alert" className="text-sa-state-error text-sm">
            {error}
          </p>
        )}
      </div>
      <SaButton
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        containerClassName="w-full"
        disabled={!complete || disabled}
        isLoading={claim.isPending}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- desde el QR basta un toque
        autoFocus={!!initialCode}
      >
        {claim.isPending ? t('form.submitting') : t('form.submit')}
      </SaButton>
    </form>
  )
}

/**
 * Modal «Vincula a tu compañero» (CR-005): el dueño escribe el código que
 * muestra la cara de Ale (o llega puesto desde el QR) y ve sus robots.
 * Estados: escribiendo → vinculando → listo, o un error claro que deja
 * reintentar. Con el canal apagado (404) avisa que no está disponible.
 */
export function RobotPairingDialog({
  open,
  onOpenChange,
  initialCode = '',
}: Props) {
  const t = useTranslations('metaAssistant.robotCompanion')
  const devices = useRobotDevices()
  const [pairedName, setPairedName] = useState<string | null>(null)
  const unavailable = isRobotChannelUnavailable(devices.error)

  const handleOpenChange = (next: boolean) => {
    if (!next) setPairedName(null)
    onOpenChange(next)
  }

  return (
    <SaModal
      open={open}
      onOpenChange={handleOpenChange}
      title={t('dialog.title')}
      description={pairedName ? undefined : t('dialog.description')}
      icon={pairedName ? undefined : Robot}
      hideTitle={!!pairedName}
      size="sm"
    >
      {pairedName ? (
        <PairedView name={pairedName} onDone={() => handleOpenChange(false)} />
      ) : (
        <>
          {unavailable && (
            <p
              role="status"
              className="bg-sa-state-info-bg text-sa-text-secondary mb-4 rounded-2xl px-4 py-3 text-sm"
            >
              {t('unavailable')}
            </p>
          )}
          <ClaimForm
            key={initialCode}
            initialCode={initialCode}
            disabled={unavailable}
            onPaired={setPairedName}
          />
          {devices.data && devices.data.length > 0 && (
            <RobotDevicesList devices={devices.data} />
          )}
        </>
      )}
    </SaModal>
  )
}
