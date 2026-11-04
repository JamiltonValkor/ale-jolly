import type { ContractErrorCode } from '../types/pairing.schemas'

/** Códigos del contrato + los que nacen en el cliente (sin red, respuesta rara). */
export type PairingErrorCode =
  | ContractErrorCode
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN'

/** Lo que la persona puede resolver; todo lo técnico se ve como «sin conexión». */
export type FlowError = ContractErrorCode | 'NETWORK'

export class CompanionPairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    readonly status: number | null = null
  ) {
    super(code)
    this.name = 'CompanionPairingError'
  }
}

export function toPairingErrorCode(error: unknown): PairingErrorCode {
  return error instanceof CompanionPairingError ? error.code : 'NETWORK'
}

export function toFlowError(code: PairingErrorCode): FlowError {
  if (code === 'INVALID_RESPONSE' || code === 'UNKNOWN') return 'NETWORK'
  return code
}

const INLINE_ERRORS: readonly FlowError[] = [
  'INVALID_CODE',
  'EXPIRED',
  'RATE_LIMITED',
]

/** Errores sobre lo que escribió: se muestran junto al campo, no en un panel. */
export function isInlineFlowError(error: FlowError): boolean {
  return INLINE_ERRORS.includes(error)
}
