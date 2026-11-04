'use client'

import type { ReactNode } from 'react'

import type { FaceState } from '../../lib/face-state'
import { CompanionFace, type SayLine } from '../face/companion-face'

/** Estados de ánimo que el flujo pide al personaje (3D o la cara 2D). */
export type CompanionMood =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'happy'
  | 'syncing'
  | 'celebrating'
  | 'worried'
  | 'confused'

export interface CompanionRenderInput {
  mood: CompanionMood
  /** Frase que dice con sincronía labial; `nonce` la repite. */
  say: SayLine | null
  /** Solo `true` tras un gesto de la persona («Probar: dile hola»). */
  voice: boolean
}

export type RenderCompanion = (input: CompanionRenderInput) => ReactNode

const FACE_FOR_MOOD: Record<CompanionMood, FaceState> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  happy: 'happy',
  syncing: 'syncing',
  celebrating: 'happy',
  worried: 'error',
  confused: 'thinking',
}

export function moodToFace(mood: CompanionMood): FaceState {
  return FACE_FOR_MOOD[mood]
}

interface Props extends Partial<CompanionRenderInput> {
  mood: CompanionMood
  renderCompanion?: RenderCompanion
  /** Cara 2D cuando no hay personaje 3D (por defecto, la del ánimo). */
  fallbackState?: FaceState
}

/**
 * El compañero dentro del flujo: el personaje 3D del líder si llega
 * `renderCompanion`; si no, la cara 2D con capucha, que también habla.
 */
export function FlowCompanion({
  mood,
  say = null,
  voice = false,
  renderCompanion,
  fallbackState,
}: Props) {
  if (renderCompanion) return <>{renderCompanion({ mood, say, voice })}</>
  return (
    <CompanionFace
      variant="head"
      state={fallbackState ?? moodToFace(mood)}
      say={say}
      voice={voice}
      decorative
    />
  )
}
