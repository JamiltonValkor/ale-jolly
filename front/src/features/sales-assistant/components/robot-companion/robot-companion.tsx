'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Robot } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { useRobotDevices } from '../../hooks/use-robot-devices'
import {
  isRobotChannelUnavailable,
  robotPairingCodeFromQuery,
} from '../../lib/robot-pairing-code'
import { RobotPairingDialog } from './robot-pairing-dialog'

/** Parámetro que agrega el QR del robot (`ROBOT_CLAIM_URL?code=XXXX-XXXX`). */
export const ROBOT_CODE_QUERY = 'code'

/**
 * Lee `?code=` una sola vez: abre el modal con el código puesto y lo quita de
 * la URL para que recargar o compartir la página no lo reabra.
 */
function useDeepLinkCode(onCode: (code: string) => void) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const raw = searchParams.get(ROBOT_CODE_QUERY)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (raw === null || handled.current === raw) return
    handled.current = raw
    const code = robotPairingCodeFromQuery(raw)
    if (code) onCode(code)
    const rest = new URLSearchParams(searchParams.toString())
    rest.delete(ROBOT_CODE_QUERY)
    const query = rest.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [raw, searchParams, pathname, router, onCode])
}

/**
 * Botón «Vincular mi compañero» de la página del agente (CR-005, D7). El QR
 * de la cara del robot abre esta página con `?code=`: el modal se abre solo
 * y basta un toque en «Vincular». Con el canal robot apagado (404) el botón
 * no se muestra, pero el enlace del QR igual explica que no está disponible.
 */
export function RobotCompanion() {
  const t = useTranslations('metaAssistant.robotCompanion')
  const devices = useRobotDevices()
  const [open, setOpen] = useState(false)
  const [initialCode, setInitialCode] = useState('')
  useDeepLinkCode(code => {
    setInitialCode(code)
    setOpen(true)
  })
  const count = devices.data?.length ?? 0
  const hidden = isRobotChannelUnavailable(devices.error)

  return (
    <>
      {!hidden && (
        <SaButton
          variant="outline"
          size="md"
          onClick={() => {
            setInitialCode('')
            setOpen(true)
          }}
          aria-haspopup="dialog"
        >
          <Robot weight="duotone" className="size-4" aria-hidden="true" />
          {t('trigger')}
          {count > 0 && (
            <span
              className="bg-sa-state-success-bg text-sa-state-success rounded-full px-2 py-0.5 text-xs font-medium"
              aria-label={t('linkedCount', { count })}
            >
              {count}
            </span>
          )}
        </SaButton>
      )}
      <RobotPairingDialog
        open={open}
        onOpenChange={setOpen}
        initialCode={initialCode}
      />
    </>
  )
}
