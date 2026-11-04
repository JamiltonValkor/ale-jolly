/**
 * Adaptador de visemas para la cara 2D: usa el mismo `buildVisemeTimeline`
 * del personaje 3D (`components/companion-3d/speech/lipsync.ts`), así la
 * boca plana y la del 3D dicen la misma frase al mismo ritmo. Un solo punto
 * para cambiar si esa firma cambia.
 */
import {
  buildVisemeTimeline,
  sampleVisemes,
  type VisemeShape,
  type VisemeTimeline,
} from '../components/companion-3d/speech/lipsync'

export { buildVisemeTimeline, sampleVisemes }
export type { VisemeShape, VisemeTimeline }

/** Segundos que dura la frase. */
export function visemeDuration(timeline: VisemeTimeline): number {
  return timeline.duration
}
