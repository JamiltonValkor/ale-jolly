'use client'

import { useEffect, useId, type CSSProperties } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

import type { FaceState } from '../../lib/face-state'
import { speakAloud } from '../../lib/speak-aloud'
import { FaceFeatures } from './face-features'
import { FACE_VIEWBOX, PLATE_VIEWBOX } from './face-geometry'
import { FaceHead } from './face-head'
import type { SayLine } from './face-mouth'
import styles from './companion-face.module.css'

export type { SayLine } from './face-mouth'

/** El crema de la pantalla del robot de Jamilton. */
export const COMPANION_PLATE_CREAM = '#F2E1BF'
/** Piel de la cara dentro de la capucha (un poco más rosada, como Muse). */
export const COMPANION_HEAD_SKIN = '#F6E3CC'

interface Props {
  state?: FaceState
  /** 0–1 desde el audio real; manda sobre `say` y el patrón automático. */
  amplitude?: number
  /** Frase que dice con sincronía labial (repite con cada `nonce`). */
  say?: SayLine | null
  /** Con `say`: también en voz alta (solo tras un gesto de la persona). */
  voice?: boolean
  /**
   * `screen`: la cara plana de la pantalla del robot (la capucha es la cabeza
   * impresa). `head`: la misma cara dentro de una capucha de peluche, para
   * avatares y tarjetas dentro de Saleads.
   */
  variant?: 'screen' | 'head'
  /** Solo `screen`: `plate` (placa redondeada) o `bleed` (llena su caja). */
  fit?: 'plate' | 'bleed'
  /** Color de la placa (`screen`) o de la piel (`head`). */
  plateColor?: string
  /** Sustituye la etiqueta traducida del estado. */
  label?: string
  /** Si el texto de al lado ya dice lo mismo, se oculta a lectores de pantalla. */
  decorative?: boolean
  className?: string
}

/** Voz del navegador con cada frase nueva, si se pidió. */
function useVoice(say: SayLine | null | undefined, voice: boolean) {
  const locale = useLocale()
  const nonce = say?.nonce
  const text = say?.text
  useEffect(() => {
    if (voice && text) speakAloud(text, locale)
  }, [voice, text, nonce, locale])
}

/**
 * Cara 2D del compañero: la de la pantalla del robot (placa crema, ojos
 * negros con brillo, rubor, sonrisa fina) con calidad Saleads. Escala a
 * cualquier tamaño: pantalla completa, tarjeta (~120 px) o avatar (26–32 px).
 */
export function CompanionFace({
  state = 'idle',
  amplitude,
  say,
  voice = false,
  variant = 'screen',
  fit = 'plate',
  plateColor,
  label,
  decorative = false,
  className,
}: Props) {
  const t = useTranslations('companion.face.label')
  const reduced = useReducedMotion() ?? false
  const ids = useId().replace(/:/g, '')
  useVoice(say, voice)
  const head = variant === 'head'
  const color =
    plateColor ?? (head ? COMPANION_HEAD_SKIN : COMPANION_PLATE_CREAM)
  const features = (
    <FaceFeatures
      state={state}
      amplitude={amplitude}
      say={say}
      reduced={reduced}
      ids={ids}
    />
  )

  return (
    <div
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : (label ?? t(state))}
      aria-hidden={decorative || undefined}
      data-state={state}
      data-variant={variant}
      className={cn(
        styles.face,
        head ? styles.head : fit === 'bleed' ? styles.bleed : styles.plate,
        className
      )}
      style={{ '--face-plate': color } as CSSProperties}
    >
      {head ? (
        <FaceHead ids={ids} skin={color}>
          {features}
        </FaceHead>
      ) : (
        <svg
          className={styles.svg}
          viewBox={
            fit === 'bleed'
              ? `0 0 ${FACE_VIEWBOX.width} ${FACE_VIEWBOX.height}`
              : PLATE_VIEWBOX
          }
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          {features}
        </svg>
      )}
    </div>
  )
}
