import QRCode from 'qrcode'

/**
 * Geometría de un QR dibujado a mano (SVG): módulos redondeados, los tres
 * ojos como piezas aparte y, si se pide, el centro libre para el isotipo
 * (con corrección H el lector recupera hasta un 30 % del símbolo).
 */

export interface QrGeometry {
  /** Módulos por lado. */
  size: number
  /** Un solo `d` con todos los módulos de datos. */
  dots: string
  /** Esquina superior izquierda de cada ojo (7×7 módulos). */
  finders: { x: number; y: number }[]
  logo: { x: number; y: number; size: number } | null
}

const MODULE = 0.88
const RADIUS = 0.3

function roundedModule(col: number, row: number): string {
  const inset = (1 - MODULE) / 2
  const x = col + inset
  const y = row + inset
  const side = MODULE - 2 * RADIUS
  const r = RADIUS
  return (
    `M${(x + r).toFixed(2)} ${y.toFixed(2)}h${side.toFixed(2)}` +
    `a${r} ${r} 0 0 1 ${r} ${r}v${side.toFixed(2)}` +
    `a${r} ${r} 0 0 1 -${r} ${r}h-${side.toFixed(2)}` +
    `a${r} ${r} 0 0 1 -${r} -${r}v-${side.toFixed(2)}` +
    `a${r} ${r} 0 0 1 ${r} -${r}z`
  )
}

function inSquare(
  col: number,
  row: number,
  square: { x: number; y: number; size: number }
): boolean {
  return (
    col >= square.x &&
    col < square.x + square.size &&
    row >= square.y &&
    row < square.y + square.size
  )
}

function logoArea(size: number): QrGeometry['logo'] {
  // Lado impar ~22 % del QR, centrado, con un módulo de aire alrededor.
  let side = Math.round(size * 0.22)
  if (side % 2 === 0) side += 1
  const start = (size - side) / 2
  return { x: start, y: start, size: side }
}

export function qrGeometry(
  text: string,
  options: { logo?: boolean } = {}
): QrGeometry {
  const qr = QRCode.create(text, {
    errorCorrectionLevel: options.logo ? 'H' : 'M',
  })
  const size = qr.modules.size
  const finders = [
    { x: 0, y: 0 },
    { x: size - 7, y: 0 },
    { x: 0, y: size - 7 },
  ]
  const logo = options.logo ? logoArea(size) : null
  const clear = logo
    ? { x: logo.x - 1, y: logo.y - 1, size: logo.size + 2 }
    : null
  let dots = ''
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!qr.modules.get(row, col)) continue
      if (finders.some(f => inSquare(col, row, { ...f, size: 7 }))) continue
      if (clear && inSquare(col, row, clear)) continue
      dots += roundedModule(col, row)
    }
  }
  return { size, dots, finders, logo }
}
