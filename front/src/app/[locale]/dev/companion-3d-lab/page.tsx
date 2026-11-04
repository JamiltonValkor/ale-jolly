import { notFound } from 'next/navigation'

import { Companion3DLab, type LabView } from './companion-3d-lab'

type LabSearchParams = Record<string, string | string[] | undefined>

interface Companion3DLabPageProps {
  searchParams: Promise<LabSearchParams>
}

const one = (v: string | string[] | undefined) =>
  typeof v === 'string' ? v : undefined
const num = (v: string | string[] | undefined) => {
  const n = Number(one(v))
  return Number.isFinite(n) && one(v) !== undefined ? n : undefined
}

const VIEWS: LabView[] = ['all', 'hero', 'card', 'avatar']

/**
 * Laboratorio del compañero 3D (solo desarrollo).
 * `?mood=dancing` · `?action=wave&at=2500` · `?seed=7` · `?autoplay=1` (carrete)
 * · `?interactive=1` · `?follow=1&px=.9&py=.1` (puntero simulado) · `?point=left`
 * · `?view=hero|card|avatar|all` · `?controls=0` · `?size=560`
 * · `?framing=head` · `?say=Hola&sayAt=3000` (lip-sync sin voz, para capturas)
 */
export default async function Companion3DLabPage({
  searchParams,
}: Companion3DLabPageProps) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const query = await searchParams
  const view = one(query.view)
  const px = num(query.px)
  const py = num(query.py)
  return (
    <Companion3DLab
      initialMood={one(query.mood)}
      view={VIEWS.includes(view as LabView) ? (view as LabView) : 'all'}
      action={one(query.action) ?? one(query.gesture)}
      actionAt={num(query.at) ?? 2500}
      seed={num(query.seed) ?? 7}
      autoplay={one(query.autoplay) === '1'}
      interactive={one(query.interactive) === '1'}
      follow={one(query.follow) === '1'}
      pointTo={one(query.point) === 'left' ? 'left' : 'right'}
      simulatedPointer={
        px !== undefined && py !== undefined ? { x: px, y: py } : null
      }
      showControls={one(query.controls) !== '0'}
      heroSize={num(query.size) ?? 420}
      framing={one(query.framing) === 'head' ? 'head' : 'full'}
      sayText={one(query.say)}
      sayAt={num(query.sayAt) ?? 3000}
    />
  )
}
