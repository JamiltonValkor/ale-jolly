import type { Bounds } from './layout'

/** Cámara 2D de la constelación: pantalla = mundo × k + (x, y). */
export interface Camera {
  x: number
  y: number
  k: number
}

export interface ZoomLimits {
  min: number
  max: number
}

export interface Viewport {
  left: number
  top: number
  right: number
  bottom: number
}

export function toScreen(
  cam: Camera,
  wx: number,
  wy: number
): [number, number] {
  return [wx * cam.k + cam.x, wy * cam.k + cam.y]
}

export function toWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.x) / cam.k, (sy - cam.y) / cam.k]
}

export function clampZoom(k: number, limits: ZoomLimits): number {
  return Math.min(limits.max, Math.max(limits.min, k))
}

export function zoomAt(
  cam: Camera,
  sx: number,
  sy: number,
  factor: number,
  limits: ZoomLimits
): Camera {
  const k = clampZoom(cam.k * factor, limits)
  const [wx, wy] = toWorld(cam, sx, sy)
  return { k, x: sx - wx * k, y: sy - wy * k }
}

export function fitBounds(
  bounds: Bounds,
  width: number,
  height: number,
  padding: number
): Camera {
  const w = Math.max(1, bounds.maxX - bounds.minX)
  const h = Math.max(1, bounds.maxY - bounds.minY)
  const k = Math.max(
    0.05,
    Math.min((width - padding * 2) / w, (height - padding * 2) / h)
  )
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k }
}

/** Centra un punto del mundo en el área visible (descontando paneles encima). */
export function centerOn(
  cam: Camera,
  wx: number,
  wy: number,
  view: Viewport,
  k = cam.k
): Camera {
  const sx = (view.left + view.right) / 2
  const sy = (view.top + view.bottom) / 2
  return { k, x: sx - wx * k, y: sy - wy * k }
}

/** Interpolación con zoom logarítmico: el acercamiento se siente parejo. */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * t)
  return { k, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
}
