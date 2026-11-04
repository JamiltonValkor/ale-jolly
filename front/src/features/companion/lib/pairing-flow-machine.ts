import { isValidPairingCode, normalizePairingCode } from './pairing-code'
import { isInlineFlowError, type FlowError } from './pairing-error'

/**
 * Pasos de la sincronización del lado de Saleads. Pura: el contenedor traduce
 * respuestas del back a eventos. Los errores sobre el código se quedan junto
 * al campo; los del mundo (sin red, ya tiene dueño) van a un panel con salida.
 *
 *   intro → connect → (business) → syncing → success
 *             ▲ └── INVALID_CODE / EXPIRED / RATE_LIMITED (en el campo)
 *             └──── error (DEVICE_OFFLINE / ALREADY_PAIRED / NETWORK) ◀─┘
 *   device → confirm-unpair → unpaired → connect
 */

export type FlowStep =
  | 'intro'
  | 'connect'
  | 'business'
  | 'syncing'
  | 'success'
  | 'error'
  | 'device'
  | 'confirm-unpair'
  | 'unpaired'

export interface FlowModel {
  step: FlowStep
  code: string
  codeFromQr: boolean
  businessId: string | null
  error: FlowError | null
  tryingHello: boolean
}

export type FlowEvent =
  | { type: 'START' }
  | { type: 'CODE_CHANGED'; code: string }
  | { type: 'CODE_SUBMITTED'; needsBusiness: boolean }
  | { type: 'BUSINESS_CHOSEN'; businessId: string }
  | { type: 'CLAIM_SUCCEEDED'; status: 'syncing' | 'paired' }
  | { type: 'CLAIM_FAILED'; error: FlowError }
  | { type: 'SYNC_COMPLETED' }
  | { type: 'BACK' }
  | { type: 'RETRY' }
  | { type: 'TRY_HELLO' }
  | { type: 'DEVICE_FOUND' }
  | { type: 'ASK_UNPAIR' }
  | { type: 'CANCEL_UNPAIR' }
  | { type: 'UNPAIRED' }
  | { type: 'PAIR_AGAIN' }

export function initialFlowModel(input: {
  initialCode?: string | null
  businessId: string | null
}): FlowModel {
  const code = normalizePairingCode(input.initialCode ?? '')
  const fromQr = isValidPairingCode(code)
  return {
    step: fromQr ? 'connect' : 'intro',
    code: fromQr ? code : '',
    codeFromQr: fromQr,
    businessId: input.businessId,
    error: null,
    tryingHello: false,
  }
}

function failed(model: FlowModel, error: FlowError): FlowModel {
  if (!isInlineFlowError(error)) return { ...model, step: 'error', error }
  return {
    ...model,
    step: 'connect',
    error,
    code: error === 'EXPIRED' ? '' : model.code,
    codeFromQr: error === 'EXPIRED' ? false : model.codeFromQr,
  }
}

const BACK_TO: Partial<Record<FlowStep, FlowStep>> = {
  connect: 'intro',
  business: 'connect',
  error: 'connect',
  'confirm-unpair': 'device',
}

export function flowReducer(model: FlowModel, event: FlowEvent): FlowModel {
  switch (event.type) {
    case 'START':
    case 'PAIR_AGAIN':
      return {
        ...model,
        step: 'connect',
        error: null,
        code: event.type === 'START' ? model.code : '',
      }
    case 'CODE_CHANGED':
      return {
        ...model,
        code: event.code,
        error: null,
        codeFromQr: model.codeFromQr && event.code === model.code,
      }
    case 'CODE_SUBMITTED':
      return event.needsBusiness ? { ...model, step: 'business' } : model
    case 'BUSINESS_CHOSEN':
      return { ...model, businessId: event.businessId }
    case 'CLAIM_SUCCEEDED':
      return {
        ...model,
        error: null,
        step: event.status === 'paired' ? 'success' : 'syncing',
      }
    case 'CLAIM_FAILED':
      return failed(model, event.error)
    case 'SYNC_COMPLETED':
      return model.step === 'syncing' ? { ...model, step: 'success' } : model
    case 'BACK':
      return { ...model, step: BACK_TO[model.step] ?? model.step, error: null }
    case 'RETRY':
      return {
        ...model,
        step: 'connect',
        error: null,
        code: model.error === 'ALREADY_PAIRED' ? '' : model.code,
      }
    case 'TRY_HELLO':
      return { ...model, tryingHello: true }
    case 'DEVICE_FOUND':
      return model.step === 'intro' ? { ...model, step: 'device' } : model
    case 'ASK_UNPAIR':
      return { ...model, step: 'confirm-unpair' }
    case 'CANCEL_UNPAIR':
      return { ...model, step: 'device' }
    case 'UNPAIRED':
      return { ...model, step: 'unpaired', code: '', codeFromQr: false }
  }
}

/** «Paso N de M» solo en los pasos con trabajo; la presentación y el final no cuentan. */
export function flowProgress(
  step: FlowStep,
  needsBusiness: boolean
): { current: number; total: number } | null {
  const total = needsBusiness ? 3 : 2
  if (step === 'connect') return { current: 1, total }
  if (step === 'business') return { current: 2, total }
  if (step === 'syncing') return { current: total, total }
  return null
}
