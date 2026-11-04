'use client'

import {
  motion,
  useAnimationFrame,
  useMotionValue,
  type MotionValue,
} from 'motion/react'

import {
  BLUSH,
  BLUSH_COLOR,
  EYE,
  FACE_INK,
  gazeToward,
  orbitPoint,
  type BrowShape,
} from './face-geometry'
import styles from './companion-face.module.css'

const BROWS: Record<BrowShape, readonly [string, string]> = {
  none: ['M-12 -30Q0 -33 12 -30', 'M-12 -30Q0 -33 12 -30'],
  // Preocupado: el extremo de adentro sube (hacia el centro de la cara).
  worried: ['M-14 -24Q-3 -27 10 -36', 'M14 -24Q3 -27 -10 -36'],
  // Curioso: solo la ceja derecha, arqueada.
  curious: ['M-12 -30Q0 -33 12 -30', 'M-12 -33Q0 -41 13 -35'],
}

export function FaceBlush({
  opacity,
  filterId,
  reduced,
}: {
  opacity: number
  filterId: string
  reduced: boolean
}) {
  return (
    <motion.g
      filter={`url(#${filterId})`}
      initial={false}
      animate={{ opacity }}
      transition={reduced ? { duration: 0 } : { duration: 0.5 }}
    >
      <ellipse
        cx={BLUSH.leftX}
        cy={BLUSH.y}
        rx={BLUSH.rx}
        ry={BLUSH.ry}
        fill={BLUSH_COLOR}
      />
      <ellipse
        cx={BLUSH.rightX}
        cy={BLUSH.y}
        rx={BLUSH.rx}
        ry={BLUSH.ry}
        fill={BLUSH_COLOR}
      />
    </motion.g>
  )
}

export function FaceBrows({
  shape,
  reduced,
}: {
  shape: BrowShape
  reduced: boolean
}) {
  const [left, right] = BROWS[shape]
  const visible = (side: 0 | 1) =>
    shape === 'worried' || (shape === 'curious' && side === 1)
  return (
    <>
      {[left, right].map((d, side) => (
        <g
          key={side}
          transform={`translate(${side === 0 ? EYE.leftX : EYE.rightX} ${EYE.y})`}
        >
          <motion.path
            className={styles.brow}
            fill="none"
            stroke={FACE_INK}
            strokeWidth={3.2}
            strokeLinecap="round"
            initial={false}
            animate={{ d, opacity: visible(side as 0 | 1) ? 0.9 : 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.3 }}
          />
        </g>
      ))}
    </>
  )
}

/** Tres «z» que suben mientras duerme. */
export function FaceZzz({ reduced }: { reduced: boolean }) {
  return (
    <g className={styles.detail} transform="translate(196 34)">
      {[0, 1, 2].map(i => (
        <motion.path
          key={i}
          d="M0 0h6l-6 7h6"
          fill="none"
          stroke={FACE_INK}
          strokeOpacity={0.42}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={`translate(${i * 7} ${-i * 9}) scale(${1 + i * 0.25})`}
          animate={
            reduced
              ? { opacity: 0.6 }
              : { opacity: [0, 0.9, 0], y: [6, -4, -12] }
          }
          transition={
            reduced
              ? { duration: 0 }
              : {
                  duration: 3,
                  repeat: Infinity,
                  delay: i * 0.8,
                  ease: 'easeOut',
                }
          }
        />
      ))}
    </g>
  )
}

const IRI = ['#FF86C8', '#A98DFF', '#62C6FF', '#5FE3C0', '#FFCF8F', '#FF86C8']

/**
 * El punto iridiscente de la sincronización (la IA de Saleads): da la vuelta
 * a la cara y los ojos lo siguen, concentrados.
 */
export function FaceSyncDot({
  gazeX,
  gazeY,
  reduced,
  glowId,
}: {
  gazeX: MotionValue<number>
  gazeY: MotionValue<number>
  reduced: boolean
  glowId: string
}) {
  const start = orbitPoint(0)
  const x = useMotionValue(start.x)
  const y = useMotionValue(start.y)
  useAnimationFrame(time => {
    if (reduced) return
    const point = orbitPoint(time / 1000)
    x.set(point.x)
    y.set(point.y)
    const gaze = gazeToward(point)
    gazeX.set(gaze.x)
    gazeY.set(gaze.y)
  })
  const color = { fill: IRI }
  const cycle = reduced
    ? { duration: 0 }
    : { duration: 5, repeat: Infinity, ease: 'linear' as const }
  return (
    <g>
      <motion.circle
        cx={x}
        cy={y}
        r={9}
        filter={`url(#${glowId})`}
        opacity={0.75}
        animate={color}
        transition={cycle}
      />
      <motion.circle cx={x} cy={y} r={3.8} animate={color} transition={cycle} />
    </g>
  )
}
