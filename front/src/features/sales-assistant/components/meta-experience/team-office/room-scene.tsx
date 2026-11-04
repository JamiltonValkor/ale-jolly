'use client'

import { useMemo } from 'react'
import type {
  TeamRole,
  TeamState,
} from '../../../lib/meta-experience/team-model'
import { museLayers, toRuns, type PixelRun } from './muse-pixels'
import {
  LOUNGE,
  PROP_PALETTE,
  ROOM_HEIGHT,
  ROOMS,
  type Prop,
} from './office-props'
import styles from './team-office.module.css'

const WALL_ROWS = 14

const propRuns = (props: Prop[]): PixelRun[] =>
  props.flatMap((prop, index) =>
    toRuns([prop.rows], PROP_PALETTE, { x: prop.x, y: prop.y }).map(run => ({
      ...run,
      layer: index,
    }))
  )

function Runs({ runs, prefix }: { runs: PixelRun[]; prefix: string }) {
  return (
    <>
      {runs.map(run => (
        <rect
          key={`${prefix}${run.layer}-${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          fill={run.fill}
        />
      ))}
    </>
  )
}

/** El ambiente de un agente: pared, piso, sus muebles y la Muse trabajando. */
export function RoomScene({
  role,
  state,
}: {
  role: TeamRole
  state: TeamState
}) {
  const room = ROOMS[role]
  const runs = useMemo(
    () => ({
      back: propRuns(room.back),
      muse: toRuns(museLayers(role, state), undefined, room.muse),
      front: propRuns(room.front),
    }),
    [role, state, room]
  )
  return (
    <svg
      viewBox={`0 0 ${room.width} ${ROOM_HEIGHT}`}
      shapeRendering="crispEdges"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      className={styles.scene}
    >
      <rect width={room.width} height={WALL_ROWS} fill={room.wall} />
      <rect
        y={WALL_ROWS}
        width={room.width}
        height={ROOM_HEIGHT - WALL_ROWS}
        fill={room.floor}
      />
      <rect
        y={WALL_ROWS}
        width={room.width}
        height={1}
        fill="rgba(0,0,0,0.25)"
      />
      <Runs runs={runs.back} prefix="b" />
      <g className={styles.muse} data-state={state}>
        <Runs runs={runs.muse} prefix="m" />
      </g>
      <Runs runs={runs.front} prefix="f" />
    </svg>
  )
}

/** La sala de descanso: solo ambiente, sin agente ni acción. */
export function LoungeScene() {
  const runs = useMemo(() => propRuns(LOUNGE.props), [])
  return (
    <div className={styles.lounge} aria-hidden>
      <svg
        viewBox={`0 0 ${LOUNGE.width} ${ROOM_HEIGHT}`}
        shapeRendering="crispEdges"
        className={styles.scene}
      >
        <rect width={LOUNGE.width} height={WALL_ROWS} fill={LOUNGE.wall} />
        <rect
          y={WALL_ROWS}
          width={LOUNGE.width}
          height={ROOM_HEIGHT - WALL_ROWS}
          fill={LOUNGE.floor}
        />
        <Runs runs={runs} prefix="l" />
      </svg>
    </div>
  )
}
