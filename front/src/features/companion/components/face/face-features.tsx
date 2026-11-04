'use client'

import { useEffect } from 'react'
import {
  animate,
  motion,
  useMotionValue,
  type TargetAndTransition,
} from 'motion/react'

import type { FaceState } from '../../lib/face-state'
import { FaceEyes } from './face-eyes'
import { FaceBlush, FaceBrows, FaceSyncDot, FaceZzz } from './face-extras'
import { FACE_CONFIG } from './face-geometry'
import { FaceMouth, type SayLine } from './face-mouth'
import { useBlink, useWander } from './use-face-motion'
import styles from './companion-face.module.css'

interface Props {
  state: FaceState
  amplitude?: number
  say?: SayLine | null
  reduced: boolean
  /** Prefijo único para los ids de filtros y recortes. */
  ids: string
}

function bodyMotion(state: FaceState, reduced: boolean): TargetAndTransition {
  const config = FACE_CONFIG[state]
  if (reduced) return { y: 0, scale: 1, transition: { duration: 0 } }
  if (state === 'waking') {
    return {
      y: [3, 3, -4, 0],
      scale: 1,
      transition: { duration: 2, times: [0, 0.5, 0.75, 1] },
    }
  }
  if (config.bounce) {
    return {
      y: [0, -2.6, 0],
      scale: 1,
      transition: {
        duration: state === 'happy' ? 0.9 : 1.5,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    }
  }
  if (config.breathe) {
    return {
      y: 0,
      scale: [1, 1.018, 1],
      transition: { duration: 3.8, repeat: Infinity, ease: 'easeInOut' },
    }
  }
  return {
    y: 0,
    scale: 1,
    transition: { type: 'spring', visualDuration: 0.6, bounce: 0.2 },
  }
}

/** La mirada: sigue al estado (y al paseo en reposo) salvo cuando sigue al punto. */
function useGaze(state: FaceState, reduced: boolean) {
  const config = FACE_CONFIG[state]
  const wander = useWander(config.wander && !reduced)
  const gazeX = useMotionValue(config.gaze.x)
  const gazeY = useMotionValue(config.gaze.y)
  const following = state === 'syncing' && !reduced
  useEffect(() => {
    if (following) return
    const transition = reduced
      ? { duration: 0 }
      : ({ type: 'spring', visualDuration: 0.55, bounce: 0.18 } as const)
    const a = animate(gazeX, config.gaze.x + wander.x, transition)
    const b = animate(gazeY, config.gaze.y + wander.y, transition)
    return () => {
      a.stop()
      b.stop()
    }
  }, [
    following,
    reduced,
    config.gaze.x,
    config.gaze.y,
    wander.x,
    wander.y,
    gazeX,
    gazeY,
  ])
  return { gazeX, gazeY }
}

/**
 * Rasgos de la cara en el lienzo 240×160 (ojos, rubor, cejas, boca y
 * extras). Lo comparten la cara de pantalla y la cabeza con capucha.
 */
export function FaceFeatures({ state, amplitude, say, reduced, ids }: Props) {
  const config = FACE_CONFIG[state]
  const blinkClosed = useBlink(config.blink && !reduced)
  const { gazeX, gazeY } = useGaze(state, reduced)
  return (
    <>
      <defs>
        <filter
          id={`${ids}-blush`}
          x="-50%"
          y="-80%"
          width="200%"
          height="260%"
        >
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
        <filter
          id={`${ids}-glow`}
          x="-200%"
          y="-200%"
          width="500%"
          height="500%"
        >
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <motion.g className={styles.body} animate={bodyMotion(state, reduced)}>
        <FaceBlush
          opacity={config.blush}
          filterId={`${ids}-blush`}
          reduced={reduced}
        />
        <FaceBrows shape={config.brows} reduced={reduced} />
        <FaceEyes
          config={config}
          blinkClosed={blinkClosed}
          gazeX={gazeX}
          gazeY={gazeY}
          waking={state === 'waking'}
          reduced={reduced}
        />
        <FaceMouth
          shape={config.mouth}
          speaking={state === 'speaking'}
          amplitude={amplitude}
          say={say}
          reduced={reduced}
          clipId={`${ids}-mouth`}
        />
      </motion.g>
      {state === 'sleeping' ? <FaceZzz reduced={reduced} /> : null}
      {state === 'syncing' ? (
        <FaceSyncDot
          gazeX={gazeX}
          gazeY={gazeY}
          reduced={reduced}
          glowId={`${ids}-glow`}
        />
      ) : null}
    </>
  )
}
