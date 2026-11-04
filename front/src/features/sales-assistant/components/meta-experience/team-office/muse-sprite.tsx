'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type {
  TeamRole,
  TeamState,
} from '../../../lib/meta-experience/team-model'
import { museLayers, toRuns } from './muse-pixels'
import styles from './team-office.module.css'

interface Props {
  role: TeamRole
  state: TeamState
  /** Lado en píxeles de pantalla; múltiplo de 16 para que no se emborrone. */
  size?: number
  className?: string
}

/** Muse en pixel art. Decorativa: el estado se dice en texto al lado. */
export function MuseSprite({ role, state, size = 64, className }: Props) {
  const runs = useMemo(() => toRuns(museLayers(role, state)), [role, state])
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden
      data-state={state}
      className={cn(styles.muse, className)}
    >
      {runs.map(run => (
        <rect
          key={`${run.layer}-${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          fill={run.fill}
        />
      ))}
    </svg>
  )
}
