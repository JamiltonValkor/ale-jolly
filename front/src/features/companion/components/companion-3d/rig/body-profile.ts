/**
 * Forma del cuerpo (sin three): una superelipse de revolución, más ancha
 * abajo (frijol) y con la capucha en cúpula. La usan la malla WebGL y la
 * silueta SVG de respaldo, así ambas son el mismo personaje.
 * Unidades de mundo: el piso es y = 0 y el personaje mide ≈ 2.1.
 */

export const BODY = {
  centerY: 1.08,
  halfHeight: 1.0,
  /** Radio máximo abajo / en la capucha. */
  widthLow: 0.9,
  widthHigh: 0.8,
  /** Exponentes de la superelipse: más alto = más cuadrado. */
  shapeLow: 2.9,
  shapeHigh: 2.35,
  /** Sección elíptica: profundidad relativa al ancho. */
  depth: 0.86,
  /** Barriga hacia adelante (perfil de frijol). */
  bean: 0.055,
  /** Pivote del giro de la capucha. */
  neckY: 1.28,
  neckZ: 0.05,
  /**
   * Franja de la barriga donde se reparte la torsión de la capucha: de aquí
   * para arriba (cara, capucha y hombros) todo gira como una pieza rígida.
   */
  twistFrom: 0.45,
  twistTo: 1.0,
} as const

/** Placa de la cara, en coordenadas de mundo sobre el frente de la capucha. */
export const FACE_PLATE = {
  centerY: 1.5,
  halfWidth: 0.56,
  /** halfHeight = halfWidth · aspect */
  halfHeight: 0.56 * 0.74,
  aspect: 0.74,
  /** Exponente de superelipse: rectángulo suave, eco de la pantalla del robot. */
  n: 3.2,
  /** Cuánto se aplana respecto a la curvatura de la capucha (1 = sigue la capucha). */
  follow: 0.88,
} as const

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** φ ∈ [0, π]: 0 = polo de abajo, π = polo de arriba. */
export function bodyPoint(phi: number): { y: number; r: number; z0: number } {
  const blend = smoothstep(Math.PI * 0.3, Math.PI * 0.75, phi)
  const p = BODY.shapeLow + (BODY.shapeHigh - BODY.shapeLow) * blend
  const width = BODY.widthLow + (BODY.widthHigh - BODY.widthLow) * blend
  const c = Math.cos(phi)
  const s = Math.max(Math.sin(phi), 0)
  const y =
    BODY.centerY - BODY.halfHeight * Math.sign(c) * Math.abs(c) ** (2 / p)
  const r = width * s ** (2 / p)
  const z0 = BODY.bean * s * s * (1 - 0.4 * blend)
  return { y, r, z0 }
}

/**
 * Cuánto del giro de la capucha recibe la altura y: 1 en toda la parte de
 * arriba (la placa de la cara nunca se tuerce ni se aplasta), 0 en la base.
 * El shader (deformBody) y los brazos (pose-binding) usan el mismo peso.
 */
export function headTwistWeight(y: number): number {
  return smoothstep(BODY.twistFrom, BODY.twistTo, y)
}

export function bodyPhiAtY(y: number): number {
  let lo = 0
  let hi = Math.PI
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (bodyPoint(mid).y < y) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** z del frente del cuerpo en (x, y). */
export function bodyFrontZ(x: number, y: number): number {
  const { r, z0 } = bodyPoint(bodyPhiAtY(y))
  return z0 + BODY.depth * Math.sqrt(Math.max(r * r - x * x, 0))
}

/** Silueta frontal cerrada (derecha de abajo arriba, izquierda de arriba abajo). */
export function bodySilhouette(steps: number): { x: number; y: number }[] {
  const right: { x: number; y: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const { y, r } = bodyPoint((i / steps) * Math.PI)
    right.push({ x: r, y })
  }
  const left = right.map(p => ({ x: -p.x, y: p.y })).reverse()
  return [...right, ...left]
}
