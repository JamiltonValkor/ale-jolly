'use client'

import type { ElementType } from 'react'

import type {
  PairingBusiness,
  PairingFlowActions,
} from '../../hooks/use-companion-pairing-flow'
import type { FlowError } from '../../lib/pairing-error'
import { flowProgress, type FlowStep } from '../../lib/pairing-flow-machine'
import type { CompanionDevice, SyncStep } from '../../types/pairing.schemas'
import type { RenderCompanion } from './flow-companion'
import { DeviceStep, UnpairedStep } from './pairing-device'
import { SheetHeader } from './pairing-layout'
import { BusinessStep, ConnectStep, IntroStep } from './pairing-steps-start'
import { ErrorStep, SuccessStep, SyncingStep } from './pairing-steps-end'

export type PairingViewActions = PairingFlowActions & { close: () => void }

/** Props planas de la vista (sin hooks de datos): el laboratorio las llena con fixtures. */
export interface PairingViewProps {
  step: FlowStep
  code: string
  codeFromQr: boolean
  error: FlowError | null
  forbiddenTyped: boolean
  businesses: readonly PairingBusiness[]
  businessId: string | null
  /** El negocio abierto en Saleads (lleva la marca «El que tienes abierto»). */
  defaultBusinessId: string | null
  businessName: string
  needsBusiness: boolean
  syncStep: SyncStep | null
  syncSlow: boolean
  device: CompanionDevice | null
  claiming: boolean
  unpairing: boolean
  unpairFailed: boolean
  tryingHello: boolean
  /** Veces que tocó «Probar: dile hola» (cada una, una frase nueva con voz). */
  helloNonce: number
  ownerFirstName: string | null
  /** El personaje 3D (ánimo, frase, voz); sin él, la cara 2D con capucha. */
  renderCompanion?: RenderCompanion
  /** Reloj para «visto hace…» (fijo en el laboratorio). */
  now?: number
  actions: PairingViewActions
  TitleComponent?: ElementType
  DescriptionComponent?: ElementType
}

function StepBody(props: PairingViewProps) {
  switch (props.step) {
    case 'intro':
      return <IntroStep props={props} />
    case 'connect':
      return <ConnectStep props={props} />
    case 'business':
      return <BusinessStep props={props} />
    case 'syncing':
      return <SyncingStep props={props} />
    case 'success':
      return <SuccessStep props={props} />
    case 'error':
      return <ErrorStep props={props} />
    case 'device':
    case 'confirm-unpair':
      return <DeviceStep props={props} />
    case 'unpaired':
      return <UnpairedStep props={props} />
  }
}

/** Vista de la sincronización: cabeza con el paso, el paso actual y su pie. */
export function CompanionPairingView(props: PairingViewProps) {
  return (
    <>
      <SheetHeader
        progress={flowProgress(props.step, props.needsBusiness)}
        onClose={props.actions.close}
      />
      <StepBody
        key={props.step === 'confirm-unpair' ? 'device-confirm' : props.step}
        {...props}
      />
    </>
  )
}
