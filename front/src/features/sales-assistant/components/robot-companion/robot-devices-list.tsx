'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Robot } from '@phosphor-icons/react'
import { saToast } from '@/shared/components/sa-sonner'
import { SaButton } from '@/shared/components/sa-button'
import type { RobotDevice } from '../../types'
import { useRevokeRobotDeviceMutation } from '../../hooks/use-robot-devices'
import { LifecycleConfirmDialog } from '../lifecycle-confirm-dialog'

function LastSeen({ value }: { value: string | null }) {
  const t = useTranslations('metaAssistant.robotCompanion.devices')
  const format = useFormatter()
  if (!value) return <>{t('neverSeen')}</>
  return (
    <>
      {t('lastSeen', {
        value: format.relativeTime(new Date(value), new Date()),
      })}
    </>
  )
}

/**
 * Robots vinculados del dueño con «Desvincular» (CR-005). Desvincular pide
 * confirmación: el robot deja de poder hablar en cuanto el servicio revoca
 * su credencial (401 en su próximo turno).
 */
export function RobotDevicesList({ devices }: { devices: RobotDevice[] }) {
  const t = useTranslations('metaAssistant.robotCompanion')
  const revoke = useRevokeRobotDeviceMutation()
  const [target, setTarget] = useState<RobotDevice | null>(null)

  const confirm = () => {
    if (!target) return
    const name = target.name
    revoke.mutate(target.id, {
      onSuccess: () => {
        saToast.success(t('revoke.success', { name }))
        setTarget(null)
      },
      onError: () => saToast.error(t('revoke.error')),
    })
  }

  return (
    <section aria-labelledby="robot-devices-title" className="mt-6">
      <h3
        id="robot-devices-title"
        className="text-sa-text-secondary text-xs font-medium tracking-wide uppercase"
      >
        {t('devices.title')}
      </h3>
      <ul className="mt-3 flex flex-col gap-2">
        {devices.map(device => (
          <li
            key={device.id}
            className="bg-sa-surface-card border-sa-border-subtle flex items-center gap-3 rounded-2xl border px-3 py-2.5"
          >
            <span
              aria-hidden="true"
              className="bg-sa-interactive-primary/10 text-sa-interactive-primary flex size-9 shrink-0 items-center justify-center rounded-full"
            >
              <Robot weight="duotone" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sa-text-primary truncate text-sm font-medium">
                {device.name}
              </p>
              <p className="text-sa-text-tertiary text-xs">
                <LastSeen value={device.last_seen_at} />
              </p>
            </div>
            <SaButton
              variant="ghost"
              size="sm"
              aria-label={t('devices.revokeLabel', { name: device.name })}
              onClick={() => setTarget(device)}
            >
              {t('devices.revoke')}
            </SaButton>
          </li>
        ))}
      </ul>
      <LifecycleConfirmDialog
        open={target !== null}
        onOpenChange={open => {
          if (!open) setTarget(null)
        }}
        title={t('revoke.title', { name: target?.name ?? '' })}
        description={t('revoke.description')}
        confirmLabel={t('revoke.confirm')}
        cancelLabel={t('revoke.cancel')}
        onConfirm={confirm}
        isPending={revoke.isPending}
        destructive
      />
    </section>
  )
}
