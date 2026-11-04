import type {
  PairingSession,
  PairingStatus,
  SyncStep,
} from '../types/pairing.schemas'
import type { FaceState } from './face-state'

/**
 * Máquina de la pantalla del robot. Pura: el hook `useRobotPairing` le pasa
 * eventos (temporizadores, respuestas del back, conexión) y pinta `screen`.
 *
 *   boot ──código + arranque──▶ pairing ──claimed/syncing──▶ syncing ──paired──▶ paired ──4 s──▶ live
 *     ▲                         │  ▲                                                          │
 *     │                 expired │  │ código nuevo                                   revoked   │
 *     │                         ▼  │                                                          │
 *     │                        expired                                                        │
 *     └───────────────────────────────────────────────────────────────────────────────────────┘
 *   Cualquier pantalla ──2 fallas seguidas o sin red──▶ offline ──respuesta del back──▶ donde iba
 */

export type RobotScreenState =
  | 'boot'
  | 'pairing'
  | 'syncing'
  | 'paired'
  | 'live'
  | 'expired'
  | 'offline'

export interface RobotModel {
  screen: RobotScreenState
  bootDone: boolean
  session: PairingSession | null
  syncStep: SyncStep | null
  ownerFirstName: string | null
  businessName: string | null
  failures: number
  /** Dónde estaba antes de quedarse sin conexión. */
  resumeTo: RobotScreenState | null
}

export type RobotEvent =
  | { type: 'BOOT_DONE' }
  | { type: 'SESSION_CREATED'; session: PairingSession }
  | { type: 'STATUS'; status: PairingStatus }
  | { type: 'REQUEST_FAILED' }
  | { type: 'CONNECTION_LOST' }
  | { type: 'CODE_EXPIRED' }
  | { type: 'PAIRED_SHOWN' }

export const initialRobotModel: RobotModel = {
  screen: 'boot',
  bootDone: false,
  session: null,
  syncStep: null,
  ownerFirstName: null,
  businessName: null,
  failures: 0,
  resumeTo: null,
}

const FAILURES_BEFORE_OFFLINE = 2

function goOffline(model: RobotModel): RobotModel {
  if (model.screen === 'offline') return model
  return { ...model, screen: 'offline', resumeTo: model.screen }
}

function wasLive(model: RobotModel): boolean {
  const where = model.screen === 'offline' ? model.resumeTo : model.screen
  return where === 'live'
}

function applyStatus(model: RobotModel, status: PairingStatus): RobotModel {
  const next: RobotModel = {
    ...model,
    failures: 0,
    resumeTo: null,
    ownerFirstName: status.owner_first_name ?? model.ownerFirstName,
    businessName: status.business_name ?? model.businessName,
  }
  switch (status.status) {
    case 'waiting':
      return model.screen === 'boot' || model.screen === 'expired'
        ? { ...next, screen: model.screen }
        : { ...next, screen: 'pairing' }
    case 'claimed':
      return { ...next, screen: 'syncing', syncStep: status.sync_step ?? null }
    case 'syncing':
      return {
        ...next,
        screen: 'syncing',
        syncStep: status.sync_step ?? model.syncStep ?? 'knowledge',
      }
    case 'paired':
      return { ...next, screen: wasLive(model) ? 'live' : 'paired' }
    case 'expired':
      return { ...next, screen: 'expired', session: null }
    case 'revoked':
      return { ...initialRobotModel }
  }
}

export function robotReducer(model: RobotModel, event: RobotEvent): RobotModel {
  switch (event.type) {
    case 'BOOT_DONE': {
      const booted = { ...model, bootDone: true }
      if (model.session) return { ...booted, screen: 'pairing' }
      return model.failures > 0 ? goOffline(booted) : booted
    }
    case 'SESSION_CREATED':
      return {
        ...model,
        session: event.session,
        failures: 0,
        syncStep: null,
        resumeTo: null,
        screen: model.bootDone ? 'pairing' : 'boot',
      }
    case 'STATUS':
      return applyStatus(model, event.status)
    case 'REQUEST_FAILED': {
      const failed = { ...model, failures: model.failures + 1 }
      if (!model.bootDone) return failed
      return failed.failures >= FAILURES_BEFORE_OFFLINE || !model.session
        ? goOffline(failed)
        : failed
    }
    case 'CONNECTION_LOST':
      return goOffline(model)
    case 'CODE_EXPIRED':
      return model.screen === 'pairing'
        ? { ...model, screen: 'expired', session: null }
        : model
    case 'PAIRED_SHOWN':
      return model.screen === 'paired' ? { ...model, screen: 'live' } : model
  }
}

const FACE_BY_SCREEN: Record<RobotScreenState, FaceState> = {
  boot: 'sleeping',
  pairing: 'idle',
  expired: 'thinking',
  syncing: 'syncing',
  paired: 'happy',
  live: 'idle',
  offline: 'error',
}

export function robotFaceFor(screen: RobotScreenState): FaceState {
  return FACE_BY_SCREEN[screen]
}
