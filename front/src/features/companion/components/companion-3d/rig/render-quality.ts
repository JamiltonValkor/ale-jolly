/**
 * Calidad de render según el tamaño del lienzo: el pelo por capas cuesta
 * relleno de píxeles, así que a menor tamaño, menos capas y menos DPR. El
 * avatar encuadra la cara (retrato) para que siga leyéndose a 48 px.
 */

export type RenderTier = 'hero' | 'card' | 'avatar'

export interface RenderQuality {
  tier: RenderTier
  pixelRatio: number
  /** Capas de pelo (shells). */
  shells: number
  /** Multiplicador del largo del pelo. */
  furScale: number
  /** Multiplicador de la frecuencia de hebras (menos = hebras más gruesas). */
  strandScale: number
  /** 0–1: hebras más suaves y menos contraste raíz/punta (evita el granulado en chico). */
  softness: number
  framing: 'full' | 'portrait' | 'head'
  /** Segmentos de la malla del cuerpo (alrededor × a lo alto). */
  segments: { around: number; along: number }
}

const DPR_CAP = 1.75

/** Encuadre pedido por quien usa el componente. */
export type RequestedFraming = 'full' | 'head'

/**
 * Con encuadre «head» la cabeza llena el lienzo: el pelo se ve ~2× más
 * grande, así que las hebras pueden ser más finas y menos suaves.
 */
export function resolveRenderQuality(
  width: number,
  height: number,
  devicePixelRatio: number,
  requested: RequestedFraming = 'full'
): RenderQuality {
  const base = baseQuality(width, height, devicePixelRatio)
  if (requested !== 'head') return base
  return {
    ...base,
    framing: 'head',
    shells: Math.max(base.shells, 18),
    strandScale: Math.min(1, base.strandScale * 1.8),
    softness: base.softness * 0.8,
    furScale: Math.max(base.furScale, 0.9),
  }
}

function baseQuality(
  width: number,
  height: number,
  devicePixelRatio: number
): RenderQuality {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1
  const side = Math.min(width, height)
  if (side >= 240) {
    return {
      tier: 'hero',
      pixelRatio: Math.min(dpr, DPR_CAP),
      shells: 34,
      furScale: 1,
      strandScale: 1,
      softness: 0,
      framing: 'full',
      segments: { around: 112, along: 88 },
    }
  }
  if (side >= 96) {
    return {
      tier: 'card',
      pixelRatio: Math.min(dpr, 1.5),
      shells: 20,
      furScale: 0.85,
      strandScale: 0.5,
      softness: 0.7,
      framing: 'full',
      segments: { around: 72, along: 56 },
    }
  }
  return {
    tier: 'avatar',
    pixelRatio: Math.min(dpr, 1.5),
    shells: 10,
    furScale: 0.7,
    strandScale: 0.38,
    softness: 1,
    framing: 'portrait',
    segments: { around: 56, along: 44 },
  }
}
