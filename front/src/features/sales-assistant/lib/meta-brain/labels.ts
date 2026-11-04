/**
 * Etiquetas de la constelación: solo las ideas más importantes, sin
 * encimarse. Codicioso por prioridad: prueba a la derecha del nodo y luego a
 * la izquierda; lo fijado (selección, hover, foco) entra siempre.
 */
export interface LabelCandidate {
  index: number
  /** Posición del nodo en pantalla (px CSS). */
  x: number
  y: number
  r: number
  width: number
  height: number
  priority: number
  pinned?: boolean
}

export type LabelSide = 'right' | 'left' | 'top' | 'bottom'

export interface PlacedLabel {
  index: number
  align: LabelSide
  /** Punto de anclaje del texto (línea base). */
  textX: number
  textY: number
  boxX: number
  boxY: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const GAP = 6
const PAD = 3

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

function boxFor(c: LabelCandidate, side: LabelSide): Box {
  const vertical = side === 'top' || side === 'bottom'
  const x = vertical
    ? c.x - c.width / 2
    : side === 'right'
      ? c.x + c.r + GAP
      : c.x - c.r - GAP - c.width
  const y =
    side === 'top'
      ? c.y - c.r - GAP - c.height
      : side === 'bottom'
        ? c.y + c.r + GAP
        : c.y - c.height / 2
  return { x: x - PAD, y: y - PAD, w: c.width + PAD * 2, h: c.height + PAD * 2 }
}

const SIDES: readonly LabelSide[] = ['right', 'left', 'top', 'bottom']

function anchor(
  c: LabelCandidate,
  side: LabelSide,
  box: Box
): { textX: number; textY: number } {
  const textY = box.y + PAD + c.height * 0.84
  if (side === 'right') return { textX: box.x + PAD, textY }
  if (side === 'left') return { textX: box.x + box.w - PAD, textY }
  return { textX: box.x + box.w / 2, textY }
}

function inside(box: Box, width: number, height: number): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.w <= width &&
    box.y + box.h <= height
  )
}

export function placeLabels(
  candidates: LabelCandidate[],
  options: {
    viewport: { width: number; height: number }
    max: number
    obstacles?: Box[]
    /** Las N más importantes pueden pisar puntos ajenos (nunca otras etiquetas). */
    strong?: number
  }
): PlacedLabel[] {
  const { width, height } = options.viewport
  const obstacles = options.obstacles ?? []
  const ordered = [...candidates].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.priority - a.priority
  )
  const taken: Box[] = []
  const placed: PlacedLabel[] = []
  let free = 0
  for (const c of ordered) {
    if (!c.pinned && free >= options.max) break
    const align = SIDES.find(side => {
      const box = boxFor(c, side)
      return (
        inside(box, width, height) &&
        (c.pinned ||
          (!taken.some(t => intersects(t, box)) &&
            (free < (options.strong ?? 0) ||
              !obstacles.some(o => intersects(o, box)))))
      )
    })
    if (!align) continue
    const box = boxFor(c, align)
    taken.push(box)
    if (!c.pinned) free += 1
    placed.push({
      index: c.index,
      align,
      ...anchor(c, align, box),
      boxX: box.x + PAD,
      boxY: box.y + PAD,
    })
  }
  return placed
}
