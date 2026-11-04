'use client'

import { motion, type MotionValue, type Transition } from 'motion/react'

import { EYE, FACE_INK, type FaceConfig } from './face-geometry'
import styles from './companion-face.module.css'

interface Props {
  config: FaceConfig
  blinkClosed: boolean
  gazeX: MotionValue<number>
  gazeY: MotionValue<number>
  waking: boolean
  reduced: boolean
}

const SPRING: Transition = { type: 'spring', visualDuration: 0.5, bounce: 0.22 }
const ARCS = {
  happy: 'M-15 5Q0 -13 15 5',
  closed: 'M-15 -1Q0 9 15 -1',
} as const

/** Al despertar: cerrado, se abre despacio, parpadea una vez y queda atento. */
const WAKE = {
  scaleY: [0.06, 0.06, 1, 1, 0.08, 1],
  transition: { duration: 2, times: [0, 0.28, 0.52, 0.7, 0.76, 0.84] },
}

function openEyeScaleY(config: FaceConfig, blinkClosed: boolean): number {
  if (config.eyes !== 'open') return 0.06
  return blinkClosed ? 0.08 : config.eyeScaleY
}

function Eye({
  config,
  blinkClosed,
  waking,
  reduced,
}: Omit<Props, 'gazeX' | 'gazeY'>) {
  const isOpen = config.eyes === 'open'
  const arc = config.eyes === 'happy' ? ARCS.happy : ARCS.closed
  const fast: Transition = reduced ? { duration: 0 } : { duration: 0.09 }
  return (
    <motion.g
      className={styles.part}
      animate={{ scale: config.eyeScale }}
      transition={reduced ? { duration: 0 } : SPRING}
    >
      <motion.g
        className={styles.part}
        initial={false}
        animate={
          waking && !reduced
            ? { scaleY: WAKE.scaleY, opacity: 1 }
            : {
                scaleY: openEyeScaleY(config, blinkClosed),
                opacity: isOpen ? 1 : 0,
              }
        }
        transition={waking && !reduced ? WAKE.transition : fast}
      >
        <ellipse rx={EYE.rx} ry={EYE.ry} fill={FACE_INK} />
        <circle cx={-5.6} cy={-6.6} r={5.4} fill="#fff" />
        <circle
          className={styles.detail}
          cx={5.6}
          cy={6.4}
          r={2.1}
          fill="#fff"
          opacity={0.85}
        />
      </motion.g>
      <motion.path
        className={styles.arc}
        fill="none"
        stroke={FACE_INK}
        strokeWidth={5.4}
        strokeLinecap="round"
        initial={false}
        animate={{ d: arc, opacity: isOpen || waking ? 0 : 1 }}
        transition={reduced ? { duration: 0 } : { duration: 0.22 }}
      />
    </motion.g>
  )
}

/** Los dos ojos: siguen la mirada (motion values) y cambian de forma por estado. */
export function FaceEyes({ gazeX, gazeY, ...eye }: Props) {
  return (
    <>
      {[EYE.leftX, EYE.rightX].map(x => (
        <g key={x} transform={`translate(${x} ${EYE.y})`}>
          <motion.g style={{ x: gazeX, y: gazeY }}>
            <Eye {...eye} />
          </motion.g>
        </g>
      ))}
    </>
  )
}
