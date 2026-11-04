'use client'

import type { ReactNode } from 'react'

import styles from './companion-face.module.css'

/** Pelaje marfil de la capucha (como Muse) y la ventana de la cara. */
export const HOOD_FUR = '#E8D8C1'
const HOOD_SHADE = '#D2BE9F'
const WINDOW = { x: 38, y: 52, width: 124, height: 94, rx: 47 } as const
/** Lleva los rasgos del lienzo 240×160 al centro de la ventana. */
const FEATURES_TRANSFORM = 'translate(100 100) scale(0.62) translate(-120 -90)'

/**
 * Silueta de la capucha: un cuadrado muy redondeado (superelipse) con mechones
 * en el borde, calculados (sin filtros: nítida en 26 px y sin artefactos).
 */
export function hoodPath(points = 144): string {
  const cx = 100
  const cy = 101
  const coords: [number, number][] = []
  for (let i = 0; i < points; i += 1) {
    const a = (i / points) * Math.PI * 2
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const tuft =
      1 + 0.011 * Math.sin(a * 46 + 0.6) + 0.008 * Math.sin(a * 71 + 2.1)
    const x = cx + Math.sign(cos) * Math.abs(cos) ** (2 / 2.7) * 88 * tuft
    const y = cy + Math.sign(sin) * Math.abs(sin) ** (2 / 2.7) * 90 * tuft
    coords.push([x, y])
  }
  const mid = (p: [number, number], q: [number, number]) =>
    `${((p[0] + q[0]) / 2).toFixed(1)} ${((p[1] + q[1]) / 2).toFixed(1)}`
  const last = coords[coords.length - 1] ?? [cx, cy]
  const first = coords[0] ?? [cx, cy]
  let d = `M${mid(last, first)}`
  coords.forEach((point, i) => {
    const next = coords[(i + 1) % coords.length] ?? first
    d += `Q${point[0].toFixed(1)} ${point[1].toFixed(1)} ${mid(point, next)}`
  })
  return `${d}Z`
}

const HOOD = hoodPath()

interface Props {
  ids: string
  skin: string
  children: ReactNode
}

/**
 * Cabeza con capucha de peluche: silueta con mechones, puntas de pelo en el
 * borde, luz suave arriba y la cara crema en su ventana con la sombra del
 * borde de la capucha. Para avatares de 26–32 px y tarjetas.
 */
export function FaceHead({ ids, skin, children }: Props) {
  return (
    <svg
      className={styles.svg}
      viewBox="0 0 200 200"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${ids}-light`} cx="36%" cy="20%" r="90%">
          <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${ids}-shade`} cx="50%" cy="46%" r="62%">
          <stop offset="0.72" stopColor={HOOD_SHADE} stopOpacity="0" />
          <stop offset="1" stopColor={HOOD_SHADE} stopOpacity="0.9" />
        </radialGradient>
        <filter
          id={`${ids}-rim`}
          filterUnits="userSpaceOnUse"
          x={WINDOW.x - 12}
          y={WINDOW.y - 12}
          width={WINDOW.width + 24}
          height={WINDOW.height + 24}
        >
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <clipPath id={`${ids}-window`}>
          <rect {...WINDOW} />
        </clipPath>
      </defs>
      <path d={HOOD} fill={HOOD_FUR} />
      <path d={HOOD} fill={`url(#${ids}-shade)`} />
      <path d={HOOD} fill={`url(#${ids}-light)`} />
      <path
        className={styles.detail}
        d={HOOD}
        fill="none"
        stroke={HOOD_FUR}
        strokeWidth={3.2}
        strokeDasharray="1.6 2.4"
        strokeLinecap="round"
      />
      <rect {...WINDOW} fill={skin} />
      <g clipPath={`url(#${ids}-window)`}>
        <g transform={FEATURES_TRANSFORM}>{children}</g>
        <rect
          {...WINDOW}
          fill="none"
          stroke="rgba(120, 86, 50, 0.3)"
          strokeWidth={7}
          filter={`url(#${ids}-rim)`}
        />
      </g>
    </svg>
  )
}
