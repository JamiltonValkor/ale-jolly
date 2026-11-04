import type { FaceState } from '@/features/companion/lib/face-state'
import type { RobotScreenState } from '@/features/companion/lib/robot-screen-machine'

/** Datos de muestra del laboratorio (solo desarrollo). */

export const LAB_OWNER = 'Nicolás'
export const LAB_BUSINESS = 'Mi Negocio'
export const LAB_CODE = 'K7P4QX'
export const LAB_QR =
  'https://app.saleads.ai/es/dashboard/meta-assistant?pair=K7P4QX'

export const LAB_ROBOT_STATES: RobotScreenState[] = [
  'boot',
  'pairing',
  'syncing',
  'paired',
  'live',
  'expired',
  'offline',
]

export const LAB_FACE_SIZES = [32, 56, 120, 220] as const

export const LAB_FRAMES = {
  '800x480': { width: 800, height: 480 },
  '1024x600': { width: 1024, height: 600 },
  '720x720': { width: 720, height: 720 },
  '390x844': { width: 390, height: 844 },
} as const

export type LabFrame = keyof typeof LAB_FRAMES

export function isLabFrame(value: string | undefined): value is LabFrame {
  return value !== undefined && value in LAB_FRAMES
}

export const LAB_LIVE_FACE: FaceState = 'speaking'
