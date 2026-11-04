// TDD-SKIP: solo tipos de las ranuras del compañero, sin lógica en runtime
import type { ReactNode, RefObject } from 'react'

/**
 * Ánimos persistentes del compañero (el mismo ser del robot físico y del
 * personaje 3D). La página traduce estos nombres a los del personaje.
 */
export type CompanionMood =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'happy'
  | 'celebrating'
  | 'sleeping'
  | 'waking'
  | 'syncing'
  | 'working'
  | 'dancing'
  | 'surprised'
  | 'shy'
  | 'confused'
  | 'worried'

/** Gestos de una sola vez (saludar, asentir…), encima del ánimo. */
export type CompanionAction =
  | 'wave'
  | 'nod'
  | 'shake'
  | 'jump'
  | 'spin'
  | 'present'

/** Pedido de gesto: `nonce` distinto = repetirlo aunque sea el mismo gesto. */
export interface CompanionActionRequest {
  name: CompanionAction
  nonce: number
}

export type CompanionSize = 'hero' | 'card' | 'mini'

/** Algo que el compañero dice: la boca lo articula (y la voz, si está activa). */
export interface CompanionSayRequest {
  text: string
  nonce: number
}

export interface CompanionRenderInput {
  mood: CompanionMood
  size: CompanionSize
  /** Nombre accesible ya traducido. */
  label: string
  action?: CompanionActionRequest | null
  /** Sigue el puntero, reacciona al pasar y al clic, se duerme si lo ignoras. */
  interactive?: boolean
  say?: CompanionSayRequest | null
  /** Leer en voz alta lo que dice (solo tras un gesto de la persona). */
  voice?: boolean
}

/** El personaje 3D lo pone la página (vive en otra feature). */
export type RenderCompanion = (input: CompanionRenderInput) => ReactNode

export interface FaceRenderInput {
  mood: CompanionMood
  /** Lado en px. */
  size: number
  label: string
}

/** La cara 2D (avatares pequeños del chat) también la pone la página. */
export type RenderFace = (input: FaceRenderInput) => ReactNode

export interface ComposerRenderInput {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  canSend: boolean
  textLimit: number
  inputRef: RefObject<HTMLTextAreaElement | null>
  label: string
  placeholder: string
  disclaimer: string
  /** Lo propio de Meta a la izquierda (leer en voz alta). */
  leading?: ReactNode
}

/** El compositor del chat del modo agente lo pone la página (vive en otra feature). */
export type RenderComposer = (input: ComposerRenderInput) => ReactNode

export type MetaTab =
  | 'today'
  | 'chat'
  | 'brain'
  | 'limits'
  | 'activity'
  | 'stock'

export const META_TABS: readonly MetaTab[] = [
  'today',
  'chat',
  'brain',
  'limits',
  'activity',
  // Siempre al final: los atajos 1 a 5 no cambian para quien la tiene oculta.
  'stock',
]
