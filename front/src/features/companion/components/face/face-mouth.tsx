'use client'

import { useEffect, useState } from 'react'
import {
  animate,
  motion,
  useAnimationFrame,
  useMotionValue,
  useTransform,
  type MotionValue,
} from 'motion/react'

import {
  buildVisemeTimeline,
  sampleVisemes,
  visemeDuration,
  type VisemeTimeline,
} from '../../lib/viseme-timeline'
import {
  FACE_INK,
  MOUTH,
  mouthPath,
  speechOpenness,
  visemeToMouth,
  type MouthShape,
} from './face-geometry'
import styles from './companion-face.module.css'

/** Una frase que la cara dice (el `nonce` la repite aunque el texto sea igual). */
export interface SayLine {
  text: string
  nonce: number
}

interface Props {
  shape: MouthShape
  speaking: boolean
  /** 0–1 desde el audio real; manda sobre todo lo demás. */
  amplitude?: number
  /** Frase con sincronía labial (visemas). */
  say?: SayLine | null
  reduced: boolean
  clipId: string
}

interface MouthValues {
  width: MotionValue<number>
  smile: MotionValue<number>
  open: MotionValue<number>
}

const SPRING = { type: 'spring', visualDuration: 0.45, bounce: 0.2 } as const

/** Mueve la boca sola mientras habla sin texto ni amplitud. */
function AutoSpeech({ open }: { open: MotionValue<number> }) {
  useAnimationFrame(time => open.set(speechOpenness(time / 1000) * 0.85))
  return null
}

/** Sincronía labial: recorre los visemas de la frase a 60 fps y avisa al terminar. */
function LipSync(props: {
  timeline: VisemeTimeline
  start: number
  base: MouthShape
  values: MouthValues
  reduced: boolean
  onDone: () => void
}) {
  const { timeline, start, base, values, reduced, onDone } = props
  useAnimationFrame(() => {
    const t = (performance.now() - start) / 1000
    if (t >= visemeDuration(timeline)) {
      onDone()
      return
    }
    const viseme = reduced
      ? { open: 0.3, round: 0, wide: 0.3 }
      : sampleVisemes(timeline, t)
    const mouth = visemeToMouth(viseme, base)
    values.width.jump(mouth.width)
    values.smile.jump(mouth.smile)
    values.open.jump(mouth.open)
  })
  return null
}

function useMouthValues(shape: MouthShape, reduced: boolean, paused: boolean) {
  const width = useMotionValue(shape.width)
  const smile = useMotionValue(shape.smile)
  const offsetX = useMotionValue(shape.offsetX ?? 0)
  const tilt = useMotionValue(shape.tilt ?? 0)
  useEffect(() => {
    if (paused) return
    const transition = reduced ? { duration: 0 } : SPRING
    const controls = [
      animate(width, shape.width, transition),
      animate(smile, shape.smile, transition),
      animate(offsetX, shape.offsetX ?? 0, transition),
      animate(tilt, shape.tilt ?? 0, transition),
    ]
    return () => controls.forEach(c => c.stop())
  }, [shape, reduced, paused, width, smile, offsetX, tilt])
  return { width, smile, offsetX, tilt }
}

/** Frase en curso: arranca con cada `nonce` nuevo y se apaga al terminar. */
function useSayLine(say: SayLine | null | undefined) {
  const [line, setLine] = useState<{
    timeline: VisemeTimeline
    start: number
  } | null>(null)
  const nonce = say?.nonce
  const text = say?.text
  useEffect(() => {
    if (nonce === undefined || !text) return
    setLine({ timeline: buildVisemeTimeline(text), start: performance.now() })
  }, [nonce, text])
  return [line, () => setLine(null)] as const
}

/**
 * Boca: una sola forma que se transforma entre estados y, al hablar, sigue
 * los visemas de la frase (o la amplitud del audio, o un patrón automático).
 */
export function FaceMouth({
  shape,
  speaking,
  amplitude,
  say,
  reduced,
  clipId,
}: Props) {
  const [line, endLine] = useSayLine(say)
  const lipSync = line !== null && amplitude === undefined
  const { width, smile, offsetX, tilt } = useMouthValues(
    shape,
    reduced,
    lipSync
  )
  const open = useMotionValue(shape.open)
  const auto = speaking && amplitude === undefined && !reduced && !lipSync

  useEffect(() => {
    if (auto || lipSync) return
    const target = amplitude !== undefined && !reduced ? amplitude : shape.open
    const control = animate(
      open,
      target,
      reduced
        ? { duration: 0 }
        : { duration: amplitude !== undefined ? 0.08 : 0.3 }
    )
    return () => control.stop()
  }, [auto, lipSync, amplitude, shape.open, reduced, open])

  const d = useTransform(() =>
    mouthPath({
      width: width.get(),
      smile: smile.get(),
      open: open.get(),
      offsetX: offsetX.get(),
      tilt: tilt.get(),
    })
  )
  const tongueX = useTransform(() => MOUTH.x + offsetX.get())
  const tongueY = useTransform(() => MOUTH.y + smile.get() + open.get() * 15)

  return (
    <g data-speaking={lipSync || auto || undefined}>
      {auto ? <AutoSpeech open={open} /> : null}
      {lipSync && line ? (
        <LipSync
          timeline={line.timeline}
          start={line.start}
          base={shape}
          values={{ width, smile, open }}
          reduced={reduced}
          onDone={endLine}
        />
      ) : null}
      <defs>
        <clipPath id={clipId}>
          <motion.path d={d} />
        </clipPath>
      </defs>
      <motion.path
        className={styles.mouth}
        d={d}
        fill={FACE_INK}
        stroke={FACE_INK}
        strokeWidth={3.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <g clipPath={`url(#${clipId})`}>
        <motion.ellipse
          cx={tongueX}
          cy={tongueY}
          rx={9}
          ry={6}
          fill="#EC7487"
        />
      </g>
    </g>
  )
}
