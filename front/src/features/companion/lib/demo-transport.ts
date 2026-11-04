import type {
  ClaimRequest,
  ClaimResponse,
  CompanionStatus,
  ContractErrorCode,
  PairingSession,
  PairingStatus,
} from '../types/pairing.schemas'
import {
  createDemoStore,
  type DemoPairingRecord,
  type DemoStore,
} from './demo-store'
import {
  DEMO_SYNC_PLAN_MS,
  deriveDemoStatus,
  isPairedRecord,
  syncStepAt,
} from './demo-status'
import { generatePairingCode } from './pairing-code'
import { CompanionPairingError } from './pairing-error'
import {
  PAIRING_TIMINGS,
  type DemoSignal,
  type PairingTransport,
  type RobotPairingHandle,
} from './pairing-transport'

/**
 * Transporte de demo para el escenario: simula al back con tiempos realistas.
 * Robot y dashboard se coordinan por `DemoStore` (localStorage + canal), así
 * que escribir en una pestaña el código que muestra otra completa las dos.
 * Nunca se usa fuera de `?demo=1`.
 */

/** Códigos de ensayo: muestran cada error sin tocar nada más. */
const REHEARSAL_ERRORS: Record<string, ContractErrorCode | 'NETWORK'> = {
  EEEEEEEE: 'EXPIRED',
  NNNNNNNN: 'INVALID_CODE',
  FFFFFFFF: 'DEVICE_OFFLINE',
  PPPPPPPP: 'ALREADY_PAIRED',
  RRRRRRRR: 'RATE_LIMITED',
  WWWWWWWW: 'NETWORK',
}

/** Un robot vivo renueva su código en segundos; más viejo que esto, no hay robot. */
const ABANDONED_AFTER_MS = 30_000

export interface DemoTransportOptions {
  store?: DemoStore
  now?: () => number
  delay?: (ms: number) => Promise<void>
  ttlMs?: number
  /** URL del dashboard a la que apunta el QR (sin query). */
  qrBaseUrl?: string
  owner?: {
    firstName?: string | null
    businesses?: readonly { id: string; name: string }[]
  }
  deviceName?: string
  /** Datos con los que el robot se reclama solo (`?name=&business=`). */
  robotOwner?: { firstName?: string | null; businessName?: string | null }
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

class DemoTransport implements PairingTransport {
  readonly kind = 'demo' as const
  private readonly store: DemoStore
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>

  constructor(private readonly options: DemoTransportOptions) {
    this.store = options.store ?? createDemoStore()
    this.now = options.now ?? (() => Date.now())
    this.delay =
      options.delay ??
      ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  }

  private newRecord(code: string, previous: string | null): DemoPairingRecord {
    const now = this.now()
    return {
      pairing_id: randomId('demo'),
      code,
      poll_token: randomId('pt'),
      created_at: now,
      expires_at: now + (this.options.ttlMs ?? PAIRING_TIMINGS.codeTtlMs),
      claimed_at: null,
      owner_first_name: null,
      business_name: null,
      device_name: null,
      previous_code: previous,
    }
  }

  private toSession(record: DemoPairingRecord): PairingSession {
    const base =
      this.options.qrBaseUrl ??
      'https://app.saleads.ai/es/dashboard/meta-assistant'
    return {
      pairing_id: record.pairing_id,
      code: record.code,
      qr_url: `${base}?pair=${record.code}&demo=1`,
      expires_at: new Date(record.expires_at).toISOString(),
      poll_token: record.poll_token,
    }
  }

  private writeClaim(
    record: DemoPairingRecord,
    firstName: string | null,
    businessName: string | null
  ) {
    this.store.write({
      pairing: {
        ...record,
        claimed_at: this.now(),
        owner_first_name: firstName,
        business_name: businessName,
        device_name: this.options.deviceName ?? null,
      },
      revoked_pairing_id: null,
    })
  }

  async createPairing(): Promise<PairingSession> {
    await this.delay(450)
    const current = this.store.read().pairing
    if (current && isPairedRecord(current, this.now()))
      return this.toSession(current)
    const replaced =
      current && current.claimed_at === null ? current.code : null
    const record = this.newRecord(generatePairingCode(), replaced)
    this.store.write({ pairing: record, revoked_pairing_id: null })
    return this.toSession(record)
  }

  async getPairingStatus(handle: RobotPairingHandle): Promise<PairingStatus> {
    await this.delay(60)
    const state = this.store.read()
    if (state.revoked_pairing_id === handle.pairing_id) {
      return { status: 'revoked' }
    }
    if (state.pairing?.pairing_id !== handle.pairing_id) {
      return { status: 'expired' }
    }
    return deriveDemoStatus(state.pairing, this.now())
  }

  /** Revisa el código contra el robot abierto; sin robot, crea uno «solo». */
  private recordFor(code: string): DemoPairingRecord {
    const record = this.store.read().pairing
    const now = this.now()
    const abandoned =
      !record ||
      (record.claimed_at === null &&
        now > record.expires_at + ABANDONED_AFTER_MS)
    if (abandoned) return this.newRecord(code, null)
    if (record.code !== code) {
      throw new CompanionPairingError(
        record.previous_code === code ? 'EXPIRED' : 'INVALID_CODE'
      )
    }
    if (record.claimed_at !== null) {
      throw new CompanionPairingError('ALREADY_PAIRED')
    }
    if (now > record.expires_at) throw new CompanionPairingError('EXPIRED')
    return record
  }

  async claim({ code, business_id }: ClaimRequest): Promise<ClaimResponse> {
    await this.delay(750)
    const rehearsal = REHEARSAL_ERRORS[code]
    if (rehearsal) throw new CompanionPairingError(rehearsal)
    const record = this.recordFor(code)
    const business = this.options.owner?.businesses?.find(
      b => b.id === business_id
    )
    this.writeClaim(
      record,
      this.options.owner?.firstName ?? null,
      business?.name ?? null
    )
    return {
      status: 'syncing',
      device_name: this.options.deviceName ?? 'Meta Assistant',
    }
  }

  async getCompanion(): Promise<CompanionStatus> {
    await this.delay(150)
    const record = this.store.read().pairing
    const now = this.now()
    if (!record || record.claimed_at === null) {
      return { paired: false, device: null }
    }
    if (!isPairedRecord(record, now)) {
      const step = syncStepAt(now - record.claimed_at)
      return { paired: false, device: null, sync_step: step }
    }
    const pairedAt = record.claimed_at + DEMO_SYNC_PLAN_MS.ready
    return {
      paired: true,
      device: {
        name: record.device_name ?? 'Meta Assistant',
        paired_at: new Date(pairedAt).toISOString(),
        last_seen_at: new Date(now).toISOString(),
      },
    }
  }

  async unpair(): Promise<void> {
    await this.delay(550)
    const record = this.store.read().pairing
    this.store.write({
      pairing: null,
      revoked_pairing_id: record?.pairing_id ?? null,
    })
  }

  subscribe(listener: (signal: DemoSignal) => void): () => void {
    return this.store.subscribe(listener)
  }

  async simulateClaim(): Promise<void> {
    const record = this.store.read().pairing
    if (!record || record.claimed_at !== null) return
    const owner = this.options.robotOwner
    this.writeClaim(
      record,
      owner?.firstName ?? null,
      owner?.businessName ?? null
    )
  }

  sayHello(): void {
    this.store.emit('hello')
  }
}

export function createDemoTransport(
  options: DemoTransportOptions = {}
): PairingTransport {
  return new DemoTransport(options)
}

export { DEMO_SYNC_PLAN_MS, deriveDemoStatus }
