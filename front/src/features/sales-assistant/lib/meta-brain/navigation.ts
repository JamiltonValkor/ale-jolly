/**
 * Teclado en la constelación: las flechas van a la idea más cercana en esa
 * dirección (cono de ±60°); si no hay ninguna, recorren en círculo el orden
 * de importancia, así nunca se queda atascado.
 */
export type Direction = 'left' | 'right' | 'up' | 'down'

const VECTORS: Record<Direction, [number, number]> = {
  right: [1, 0],
  left: [-1, 0],
  down: [0, 1],
  up: [0, -1],
}

export function nextNode(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  order: number[],
  current: number | null,
  direction: Direction
): number | null {
  if (!order.length) return null
  if (current === null || !order.includes(current)) return order[0]
  const [ux, uy] = VECTORS[direction]
  let best: number | null = null
  let bestScore = Infinity
  for (const i of order) {
    if (i === current) continue
    const dx = xs[i] - xs[current]
    const dy = ys[i] - ys[current]
    const d = Math.hypot(dx, dy)
    if (d === 0) continue
    const along = (dx * ux + dy * uy) / d
    if (along < 0.5) continue
    const score = d * (2 - along)
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best !== null) return best
  const step = direction === 'right' || direction === 'down' ? 1 : -1
  const at = order.indexOf(current)
  return order[(at + step + order.length) % order.length]
}
