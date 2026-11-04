/**
 * `*_minor` del canal del agente (C-18) en el offset de Meta, igual que
 * `sa-integration-service/src/domain/agent-mirror/spendProjection.ts`:
 * monedas sin decimales en Meta usan 1 (COP = pesos enteros, V-E10), el
 * resto 100. No es el exponente ISO (COP tiene 2 en ISO).
 */
const OFFSET_ONE = new Set([
  'CLP',
  'COP',
  'CRC',
  'HUF',
  'IDR',
  'ISK',
  'JPY',
  'KRW',
  'PYG',
  'TWD',
  'VND',
])

export function minorToMajor(minor: number, currency: string): number {
  return OFFSET_ONE.has(currency.toUpperCase()) ? minor : minor / 100
}
