'use client'

import { useMemo } from 'react'

import { qrGeometry } from '../../lib/qr-geometry'

interface Props {
  url: string
  alt: string
  className?: string
}

const INK = '#16120E'

/**
 * QR dibujado en SVG (sin imágenes ni red): módulos redondeados en tinta
 * sobre el crema de la cara y el isotipo de Saleads al centro.
 */
export function RobotQr({ url, alt, className }: Props) {
  const geometry = useMemo(() => qrGeometry(url, { logo: true }), [url])
  const { size, logo } = geometry
  return (
    <svg
      role="img"
      aria-label={alt}
      viewBox={`-0.5 -0.5 ${size + 1} ${size + 1}`}
      className={className}
      shapeRendering="geometricPrecision"
    >
      <path d={geometry.dots} fill={INK} />
      {geometry.finders.map(({ x, y }) => (
        <g key={`${x}-${y}`}>
          <rect
            x={x + 0.5}
            y={y + 0.5}
            width={6}
            height={6}
            rx={1.9}
            fill="none"
            stroke={INK}
            strokeWidth={1}
          />
          <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.95} fill={INK} />
        </g>
      ))}
      {logo ? (
        <svg
          x={logo.x + logo.size * 0.2}
          y={logo.y + logo.size * 0.08}
          width={logo.size * 0.6}
          height={logo.size * 0.84}
          viewBox="0 0 61.91 100"
        >
          <path
            fill={INK}
            fillRule="evenodd"
            d="M37.85 99.94L33.78 99.92L33.17 99.76L33.13 93.34L32.92 93.38L31.58 94.39L30.96 94.52L30.41 94.39L28.21 92.76L28.14 92.87L28.06 99.76L27.51 99.94L23.51 99.92L22.88 99.77L22.86 88.79L1.72 73.07L0.61 71.94L0.22 71.16L0.04 70.45L0.04 50.71L0.47 49.97L1.10 49.66L1.57 49.66L2.19 49.97L23.00 65.52L23.14 42.48L1.33 26.51L0.92 26.02L0.79 25.39L0.90 24.76L1.49 24.12L23.30 7.76L23.38 0.24L23.51 0.07L23.90 -0.02L28.45 0.07L28.64 0.24L28.63 3.68L30.25 2.56L30.96 2.39L31.66 2.62L33.62 4.06L33.70 0.13L34.17 -0.02L36.68 -0.02L38.32 -0.00L38.86 0.16L38.92 8.07L60.19 23.95L61.16 25.00L61.55 25.78L61.79 26.72L61.79 45.85L61.63 46.39L61.39 46.71L60.58 47.14L60.11 47.14L59.33 46.74L38.87 31.40L38.75 31.43L38.64 54.00L46.32 59.91L60.66 70.67L60.93 71.00L61.07 71.63L60.90 72.26L60.42 72.76L38.44 89.26L38.37 99.69L38.32 99.80L37.85 99.94ZM30.18 70.30L30.72 69.96L31.07 69.36L31.11 48.28L33.36 49.92L33.50 27.43L33.23 27.18L32.76 27.00L32.21 27.00L31.66 27.26L31.23 27.74L31.07 28.29L31.07 48.12L30.96 48.13L28.53 46.38L28.40 46.39L28.25 69.44L29.23 70.23L29.55 70.34L30.18 70.30Z"
          />
        </svg>
      ) : null}
    </svg>
  )
}
