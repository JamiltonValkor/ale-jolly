import * as THREE from 'three'

/**
 * Isotipo de Saleads (public/agent-chat/v2/saleads-isotipo.svg) como
 * geometría vectorial: nítido a cualquier tamaño en la etiqueta del peluche.
 */
export const ISOTYPE_PATH =
  'M37.85 99.94L33.78 99.92L33.17 99.76L33.13 93.34L32.92 93.38L31.58 94.39L30.96 94.52L30.41 94.39L28.21 92.76L28.14 92.87L28.06 99.76L27.51 99.94L23.51 99.92L22.88 99.77L22.86 88.79L1.72 73.07L0.61 71.94L0.22 71.16L0.04 70.45L0.04 50.71L0.47 49.97L1.10 49.66L1.57 49.66L2.19 49.97L23.00 65.52L23.14 42.48L1.33 26.51L0.92 26.02L0.79 25.39L0.90 24.76L1.49 24.12L23.30 7.76L23.38 0.24L23.51 0.07L23.90 -0.02L28.45 0.07L28.64 0.24L28.63 3.68L30.25 2.56L30.96 2.39L31.66 2.62L33.62 4.06L33.70 0.13L34.17 -0.02L36.68 -0.02L38.32 -0.00L38.86 0.16L38.92 8.07L60.19 23.95L61.16 25.00L61.55 25.78L61.79 26.72L61.79 45.85L61.63 46.39L61.39 46.71L60.58 47.14L60.11 47.14L59.33 46.74L38.87 31.40L38.75 31.43L38.64 54.00L46.32 59.91L60.66 70.67L60.93 71.00L61.07 71.63L60.90 72.26L60.42 72.76L38.44 89.26L38.37 99.69L38.32 99.80L37.85 99.94ZM30.18 70.30L30.72 69.96L31.07 69.36L31.11 48.28L33.36 49.92L33.50 27.43L33.23 27.18L32.76 27.00L32.21 27.00L31.66 27.26L31.23 27.74L31.07 28.29L31.07 48.12L30.96 48.13L28.53 46.38L28.40 46.39L28.25 69.44L29.23 70.23L29.55 70.34L30.18 70.30Z'

const ISOTYPE_SIZE = { width: 61.91, height: 100 }

/** Lee un path SVG de solo M/L/Z absolutos en polígonos. */
export function parsePolygonPath(d: string): [number, number][][] {
  const polys: [number, number][][] = []
  let current: [number, number][] = []
  const tokens = d.match(/[MLZ]|-?\d*\.?\d+/gi) ?? []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toUpperCase()
    if (t === 'M') {
      if (current.length) polys.push(current)
      current = []
    } else if (t === 'Z') {
      if (current.length) polys.push(current)
      current = []
    } else if (t !== 'L') {
      current.push([Number(tokens[i]), Number(tokens[i + 1])])
      i++
    }
  }
  if (current.length) polys.push(current)
  return polys
}

/** Geometría del isotipo centrada, de alto `height`, y hacia arriba. */
export function createIsotypeGeometry(height: number): THREE.ShapeGeometry {
  const s = height / ISOTYPE_SIZE.height
  const toVec = ([x, y]: [number, number]) =>
    new THREE.Vector2(
      (x - ISOTYPE_SIZE.width / 2) * s,
      (ISOTYPE_SIZE.height / 2 - y) * s
    )
  const [outer, ...holes] = parsePolygonPath(ISOTYPE_PATH)
  const shape = new THREE.Shape(outer.map(toVec))
  for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(toVec)))
  const g = new THREE.ShapeGeometry(shape)
  g.computeBoundingBox()
  const box = g.boundingBox
  if (box) {
    g.translate(-(box.max.x + box.min.x) / 2, -(box.max.y + box.min.y) / 2, 0)
  }
  return g
}

/** Etiqueta de tela con esquinas redondeadas, centrada. */
export function createTagGeometry(
  width: number,
  height: number,
  radius: number
): THREE.ShapeGeometry {
  const w = width / 2
  const h = height / 2
  const r = Math.min(radius, w, h)
  const shape = new THREE.Shape()
  shape.moveTo(-w + r, -h)
  shape.lineTo(w - r, -h)
  shape.quadraticCurveTo(w, -h, w, -h + r)
  shape.lineTo(w, h - r)
  shape.quadraticCurveTo(w, h, w - r, h)
  shape.lineTo(-w + r, h)
  shape.quadraticCurveTo(-w, h, -w, h - r)
  shape.lineTo(-w, -h + r)
  shape.quadraticCurveTo(-w, -h, -w + r, -h)
  return new THREE.ShapeGeometry(shape, 6)
}
