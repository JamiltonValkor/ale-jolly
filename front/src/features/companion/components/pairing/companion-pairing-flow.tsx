'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'

import { DialogDescription, DialogTitle } from '@/components/ui/dialog'

import {
  useCompanionPairingFlow,
  type PairingBusiness,
} from '../../hooks/use-companion-pairing-flow'
import { PairingTransportProvider } from '../../hooks/use-pairing-transport'
import { createDemoTransport } from '../../lib/demo-transport'
import { devicesTransport } from '../../lib/devices-transport'
import type { PairingTransport } from '../../lib/pairing-transport'
import { CompanionPairingView } from './companion-pairing-view'
import type { RenderCompanion } from './flow-companion'
import { PairingDialog } from './pairing-dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Código del QR: `/{locale}/dashboard/meta-assistant?pair=CODE`. */
  initialCode?: string | null
  businesses: readonly PairingBusiness[]
  /** Negocio abierto en Saleads (por defecto el que va a conocer). */
  selectedBusinessId?: string | null
  ownerFirstName?: string | null
  /**
   * El personaje 3D: recibe `{ mood, say, voice }` en cada paso. Sin él, la
   * cara 2D con capucha (que también habla con sincronía labial).
   */
  renderCompanion?: RenderCompanion
  /** `demo` con `?demo=1`: se coordina con `/companion?demo=1` en otra pestaña. */
  mode?: PairingTransport['kind']
  className?: string
}

interface BodyProps extends Pick<
  Props,
  | 'initialCode'
  | 'businesses'
  | 'selectedBusinessId'
  | 'renderCompanion'
  | 'ownerFirstName'
> {
  onClose: () => void
}

function FlowBody(props: BodyProps) {
  const {
    initialCode,
    businesses,
    selectedBusinessId,
    renderCompanion,
    ownerFirstName,
    onClose,
  } = props
  const t = useTranslations('companion.flow')
  const flow = useCompanionPairingFlow({
    initialCode,
    businesses,
    selectedBusinessId,
  })
  const { model } = flow
  return (
    <CompanionPairingView
      step={model.step}
      code={model.code}
      codeFromQr={model.codeFromQr}
      error={model.error}
      forbiddenTyped={flow.forbiddenTyped}
      businesses={businesses}
      businessId={model.businessId}
      defaultBusinessId={selectedBusinessId ?? businesses[0]?.id ?? null}
      businessName={flow.business?.name ?? t('yourBusiness')}
      needsBusiness={flow.needsBusiness}
      syncStep={flow.syncStep}
      syncSlow={flow.syncSlow}
      device={flow.device}
      claiming={flow.claiming}
      unpairing={flow.unpairing}
      unpairFailed={flow.unpairFailed}
      tryingHello={model.tryingHello}
      helloNonce={flow.helloNonce}
      ownerFirstName={ownerFirstName ?? null}
      renderCompanion={renderCompanion}
      actions={{ ...flow.actions, close: onClose }}
      TitleComponent={DialogTitle}
      DescriptionComponent={DialogDescription}
    />
  )
}

/**
 * «Sincroniza tu compañero con Saleads»: el modal que se abre desde la
 * tarjeta «Compañero físico» de Meta Assistant. Contenedor: elige el
 * transporte y conecta la vista con los hooks.
 */
export function CompanionPairingFlow({
  open,
  onOpenChange,
  initialCode,
  businesses,
  selectedBusinessId,
  ownerFirstName,
  renderCompanion,
  mode = 'http',
  className,
}: Props) {
  const t = useTranslations('companion.flow')
  const deviceName = ownerFirstName
    ? t('demoDeviceName', { name: ownerFirstName })
    : t('demoDeviceNameNoName')
  const transport = useMemo<PairingTransport>(
    () =>
      mode === 'demo'
        ? createDemoTransport({
            owner: { firstName: ownerFirstName, businesses },
            deviceName,
          })
        : devicesTransport,
    [mode, ownerFirstName, businesses, deviceName]
  )
  return (
    <PairingTransportProvider transport={transport}>
      <PairingDialog
        open={open}
        onOpenChange={onOpenChange}
        className={className}
      >
        <FlowBody
          initialCode={initialCode}
          businesses={businesses}
          selectedBusinessId={selectedBusinessId}
          ownerFirstName={ownerFirstName}
          renderCompanion={renderCompanion}
          onClose={() => onOpenChange(false)}
        />
      </PairingDialog>
    </PairingTransportProvider>
  )
}
