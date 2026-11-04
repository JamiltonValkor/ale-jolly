/** Internal diagnostics only. Never copy arbitrary error text or network addresses. */
export const TRANSPORT_ERROR_CODES = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
] as const
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number]
const codes: ReadonlySet<string> = new Set(TRANSPORT_ERROR_CODES)

/** Read data descriptors only: diagnostics must not invoke accessors or throw. */
function ownValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

export function transportErrorCode(
  error: unknown
): TransportErrorCode | undefined {
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  for (let inspected = 0; pending.length && inspected < 8; inspected++) {
    const value = pending.shift()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    const code = ownValue(value, 'code')
    if (typeof code === 'string' && codes.has(code))
      return code as TransportErrorCode
    pending.push(ownValue(value, 'cause'))
    const errors = ownValue(value, 'errors')
    try {
      if (Array.isArray(errors)) {
        const length = ownValue(errors, 'length')
        for (
          let index = 0;
          typeof length === 'number' && index < Math.min(length, 4);
          index++
        )
          pending.push(ownValue(errors, String(index)))
      }
    } catch {
      // A revoked proxy is not useful evidence; omit it without changing outcomes.
    }
  }
  return undefined
}
