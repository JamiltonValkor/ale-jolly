import type { RenderQuality } from './render-quality'

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

/** Dónde queda la cara dentro del lienzo, como fracción del alto. */
const HEAD_Y: Record<RenderQuality['framing'], number> = {
  full: 0.3,
  portrait: 0.45,
  head: 0.52,
}

/**
 * Puntero → coordenadas del rig, relativas a la cara del personaje y
 * escaladas por el tamaño de la ventana: lo sigue en toda la página.
 */
export function normalizePointer(
  clientX: number,
  clientY: number,
  rect: RectLike,
  viewport: { width: number; height: number },
  framing: RenderQuality['framing']
): { x: number; y: number } {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height * HEAD_Y[framing]
  const sx = Math.max(viewport.width * 0.32, 1)
  const sy = Math.max(viewport.height * 0.32, 1)
  return { x: (clientX - cx) / sx, y: (cy - clientY) / sy }
}
