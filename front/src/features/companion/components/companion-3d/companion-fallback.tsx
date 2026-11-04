import { useId } from 'react'

import { cn } from '@/lib/utils'

import styles from './companion-fallback.module.css'
import { bodySilhouette, FACE_PLATE } from './rig/body-profile'
import type { CompanionAction, CompanionMood } from './rig/companion-moods'
import {
  FACE,
  closedEyePath,
  eyeCenter,
  fallbackFace,
  mouthPath,
  superellipsePath,
} from './rig/face-layout'
import type { RenderQuality } from './rig/render-quality'

/**
 * Respaldo SVG del compañero: misma silueta y misma cara que el WebGL. Se usa
 * mientras carga three (sin salto de layout) y cuando no hay WebGL o se pierde
 * el contexto. Es decorativo: el nombre accesible lo pone el contenedor.
 */

interface Props {
  mood: CompanionMood
  framing: RenderQuality['framing']
  reducedMotion?: boolean
  gesture?: { kind: CompanionAction; nonce: number } | null
  className?: string
}

/** Mismo encuadre que la cámara 3D (pose-binding.ts → frameCamera). */
const VIEWBOX: Record<RenderQuality['framing'], string> = {
  full: '-1.45 -2.66 2.9 2.84',
  portrait: '-0.66 -2.1 1.32 1.2',
  head: '-0.9 -2.36 1.8 1.68',
}

/** Sin WebGL, cada acción se resume en uno de cuatro movimientos CSS suaves. */
const CSS_MOTION: Record<CompanionAction, 'jump' | 'nod' | 'wave' | 'wake'> = {
  wave: 'wave',
  nod: 'nod',
  shake: 'nod',
  jump: 'jump',
  spin: 'jump',
  surprised: 'jump',
  giggle: 'wave',
  wake: 'wake',
  present: 'wave',
  sigh: 'wake',
  hello: 'nod',
  lookAtHand: 'nod',
  tinyHop: 'jump',
  stretch: 'wake',
  lookAround: 'nod',
  scratch: 'wave',
  shiftFeet: 'wave',
  yawn: 'wake',
}

const BODY_PATH = (() => {
  const pts = bodySilhouette(56).map(
    p => `${p.x.toFixed(3)} ${(-p.y).toFixed(3)}`
  )
  return `M${pts.join(' L')} Z`
})()

/** Cara en coordenadas SVG (y hacia abajo), centrada en la placa. */
const HW = FACE_PLATE.halfWidth
const CY = -FACE_PLATE.centerY
const fx = (x: number) => x * HW
const fy = (y: number) => CY - y * HW

function Eyes({ mood }: { mood: CompanionMood }) {
  const face = fallbackFace(mood)
  const r = FACE.eye.r * HW * face.eyeScale
  return (
    <>
      {([-1, 1] as const).map(side => {
        const c = eyeCenter(side, face.gazeX, face.gazeY)
        if (face.eyes !== 'open') {
          const curve = face.eyes === 'happy' ? 0.5 : -0.5
          return (
            <path
              key={side}
              data-part="eye"
              d={closedEyePath(fx(c.x), fy(c.y), r, curve)}
              fill="none"
              stroke="#151113"
              strokeWidth={r * 0.32}
              strokeLinecap="round"
            />
          )
        }
        return (
          <g key={side}>
            <ellipse
              data-part="eye"
              cx={fx(c.x)}
              cy={fy(c.y)}
              rx={r}
              ry={r * FACE.eye.stretchY}
              fill="#151113"
            />
            <circle
              cx={fx(c.x) + FACE.highlight.dx * r}
              cy={fy(c.y) - FACE.highlight.dy * r}
              r={FACE.highlight.r * r}
              fill="#FFFFFF"
            />
            <circle
              cx={fx(c.x) + FACE.highlightSmall.dx * r}
              cy={fy(c.y) - FACE.highlightSmall.dy * r}
              r={FACE.highlightSmall.r * r}
              fill="#FFFFFF"
              opacity={0.85}
            />
          </g>
        )
      })}
    </>
  )
}

function Face({ mood, blushId }: { mood: CompanionMood; blushId: string }) {
  const face = fallbackFace(mood)
  const mouth = mouthPath(
    fx(0),
    fy(FACE.mouth.y),
    FACE.mouth.halfWidth * HW,
    face.smile,
    face.mouthOpen
  )
  return (
    <g>
      <path
        d={superellipsePath(0, CY, HW, HW * FACE.aspect, FACE.n, 72)}
        fill="#F6E7D2"
      />
      {([-1, 1] as const).map(side => (
        <ellipse
          key={side}
          cx={fx(side * FACE.blush.x)}
          cy={fy(FACE.blush.y)}
          rx={FACE.blush.rx * HW * 1.3}
          ry={FACE.blush.ry * HW * 1.3}
          fill={`url(#${blushId})`}
          opacity={face.blush}
        />
      ))}
      <Eyes mood={mood} />
      <path
        data-part="mouth"
        data-open={mouth.filled ? 'true' : 'false'}
        d={mouth.d}
        fill={mouth.filled ? '#5A2A30' : 'none'}
        stroke="#151113"
        strokeWidth={FACE.mouth.thickness * HW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  )
}

function Limbs({ furId }: { furId: string }) {
  return (
    <g fill={`url(#${furId})`}>
      {([-1, 1] as const).map(side => (
        <g key={side}>
          <ellipse
            cx={side * 0.84}
            cy={-0.74}
            rx={0.19}
            ry={0.31}
            transform={`rotate(${side * -17} ${side * 0.84} -0.74)`}
          />
          <ellipse cx={side * 0.34} cy={-0.13} rx={0.21} ry={0.14} />
        </g>
      ))}
    </g>
  )
}

/** Retrato: el cuerpo se desvanece bajo la capucha, igual que en 3D (uFadeY). */
function BustFade({ id }: { id: string }) {
  return (
    <>
      <linearGradient
        id={`${id}-g`}
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="-0.62"
        x2="0"
        y2="-1.17"
      >
        <stop offset="0" stopColor="#fff" stopOpacity="0" />
        <stop offset="1" stopColor="#fff" stopOpacity="1" />
      </linearGradient>
      <mask
        id={id}
        maskUnits="userSpaceOnUse"
        x="-2"
        y="-3"
        width="4"
        height="3.2"
      >
        <rect x="-2" y="-3" width="4" height="3.2" fill={`url(#${id}-g)`} />
      </mask>
    </>
  )
}

export function CompanionFallback({
  mood,
  framing,
  reducedMotion = false,
  gesture = null,
  className,
}: Props) {
  const uid = useId().replace(/:/g, '')
  const furId = `companion-fur-${uid}`
  const blushId = `companion-blush-${uid}`
  const fadeId = `companion-fade-${uid}`
  const active = gesture && !reducedMotion ? gesture : null
  return (
    <svg
      viewBox={VIEWBOX[framing]}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      data-mood={mood}
      data-gesture={active?.kind}
      className={cn('block size-full', className)}
    >
      <defs>
        <radialGradient id={furId} cx="42%" cy="34%" r="75%">
          <stop offset="0%" stopColor="#F7F1E6" />
          <stop offset="62%" stopColor="#E6DCCB" />
          <stop offset="100%" stopColor="#B9AC98" />
        </radialGradient>
        <radialGradient id={blushId}>
          <stop offset="0%" stopColor="#FF9AA6" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#FF9AA6" stopOpacity="0" />
        </radialGradient>
        {framing === 'head' && <BustFade id={fadeId} />}
      </defs>
      <ellipse
        cx={0}
        cy={-0.01}
        rx={1}
        ry={0.12}
        fill="#000000"
        opacity={0.35}
      />
      <g
        key={active?.nonce ?? 0}
        mask={framing === 'head' ? `url(#${fadeId})` : undefined}
        className={cn(styles.figure, active && styles[CSS_MOTION[active.kind]])}
      >
        <Limbs furId={furId} />
        <path d={BODY_PATH} fill={`url(#${furId})`} />
        <Face mood={mood} blushId={blushId} />
      </g>
    </svg>
  )
}
