'use client'

import nextDynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Carga perezosa del grafo (OSF-001): sigma y graphology quedan fuera del
 * chunk inicial de la ruta y nunca se evalúan en el servidor.
 */
export const BrainGraphCanvasLazy = nextDynamic(
  () => import('./brain-graph-canvas').then(module => module.BrainGraphCanvas),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[420px] w-full rounded-xl" />,
  }
)
