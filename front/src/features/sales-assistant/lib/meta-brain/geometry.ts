/** Curvas cuadráticas de las aristas y búsqueda del nodo bajo el cursor. */

export function controlPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bend = 0.16,
  sign = 1
): [number, number] {
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const dx = bx - ax
  const dy = by - ay
  return [mx - dy * bend * sign, my + dx * bend * sign]
}

export function quadPoint(
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  bx: number,
  by: number,
  t: number
): [number, number] {
  const u = 1 - t
  return [
    u * u * ax + 2 * u * t * cx + t * t * bx,
    u * u * ay + 2 * u * t * cy + t * t * by,
  ]
}

/** Primer tramo de la curva hasta t: [inicio, control, fin]. */
export function splitQuad(
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  bx: number,
  by: number,
  t: number
): [number, number, number, number, number, number] {
  const c1x = ax + (cx - ax) * t
  const c1y = ay + (cy - ay) * t
  const [px, py] = quadPoint(ax, ay, cx, cy, bx, by, t)
  return [ax, ay, c1x, c1y, px, py]
}

/** Índice del nodo visible más cercano a (wx, wy) dentro de su radio + holgura, o -1. */
export function hitTest(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  rs: ArrayLike<number>,
  visible: ArrayLike<boolean>,
  wx: number,
  wy: number,
  slop: number
): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < xs.length; i++) {
    if (!visible[i]) continue
    const d = Math.hypot(xs[i] - wx, ys[i] - wy)
    if (d <= rs[i] + slop && d < bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}
