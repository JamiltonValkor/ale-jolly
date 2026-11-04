import type {
  ClaimRequest,
  ClaimResponse,
  CompanionStatus,
  PairingSession,
  PairingStatus,
} from '../types/pairing.schemas'
import type { RobotScreenState } from './robot-screen-machine'

/** Lo que el robot guarda para consultar su código (el poll token nunca va en el QR). */
export interface RobotPairingHandle {
  pairing_id: string
  poll_token: string
}

/** Señales entre pestañas del modo demo (BroadcastChannel / localStorage). */
export type DemoSignal = 'changed' | 'hello'

/**
 * Frontera entre la UI y el back del compañero. Dos implementaciones
 * explícitas: `createHttpTransport` (endpoints reales, validados con zod) y
 * `createDemoTransport` (simulación para el escenario de la hackatón).
 */
export interface PairingTransport {
  readonly kind: 'http' | 'demo'
  // Robot (sin sesión)
  createPairing(input?: { deviceId?: string }): Promise<PairingSession>
  getPairingStatus(handle: RobotPairingHandle): Promise<PairingStatus>
  // Dueño (con sesión)
  claim(input: ClaimRequest): Promise<ClaimResponse>
  getCompanion(): Promise<CompanionStatus>
  unpair(): Promise<void>
  // Solo demo
  /** Avisa al instante de cambios hechos en otra pestaña. */
  subscribe?(listener: (signal: DemoSignal) => void): () => void
  /** El robot se reclama a sí mismo (escenario con un solo dispositivo). */
  simulateClaim?(): Promise<void>
  /** «Probar: dile hola»: el robot de la demo saluda. */
  sayHello?(): void
}

export const PAIRING_TIMINGS = {
  /** Vida de un código (el back manda `expires_at`; esto es el valor esperado). */
  codeTtlMs: 10 * 60 * 1000,
  robotPollWaitingMs: 2000,
  robotPollSyncingMs: 1000,
  /** Ya sincronizado: vigila si lo desvinculan (`revoked`). */
  robotPollPairedMs: 15000,
  ownerPollSyncingMs: 1000,
  /** Pasado esto, la sincronización avisa que tarda más de lo normal. */
  syncSlowAfterMs: 30000,
  offlineRetryMs: 10000,
  bootMinMs: 1800,
  pairedHoldMs: 4200,
  renewDelayMs: 1600,
} as const

const DEMO_POLL_MS = 400

export function robotPollInterval(
  screen: RobotScreenState,
  kind: PairingTransport['kind']
): number | false {
  if (screen === 'boot' || screen === 'offline') return false
  if (screen === 'paired' || screen === 'live') {
    return kind === 'demo' ? 1000 : PAIRING_TIMINGS.robotPollPairedMs
  }
  if (kind === 'demo') return DEMO_POLL_MS
  return screen === 'syncing'
    ? PAIRING_TIMINGS.robotPollSyncingMs
    : PAIRING_TIMINGS.robotPollWaitingMs
}
