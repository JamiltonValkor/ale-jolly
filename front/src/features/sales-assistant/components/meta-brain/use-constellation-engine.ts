'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { ConstellationEngine } from '../../lib/meta-brain/engine'
import type { SceneModel } from '../../lib/meta-brain/scene-model'

export interface HoverInfo {
  index: number
  x: number
  y: number
}

interface ViewInput {
  day: number
  hidden: ReadonlySet<string>
  focusIds: Set<string> | null
  selectedId: string | null
  keyFocus: number
  insetLeft: number
  insetRight: number
  /** Pedido de viaje de cámara (búsqueda, lista, relaciones). */
  flyTo?: { id: string; seq: number } | null
}

interface Options {
  canvasRef: RefObject<HTMLCanvasElement | null>
  wrapRef: RefObject<HTMLDivElement | null>
  model: SceneModel
  reduced: boolean
  onHover: (hover: HoverInfo | null) => void
  view: ViewInput
}

function watchSize(engine: ConstellationEngine, wrap: HTMLElement) {
  const measure = () =>
    engine.resize(
      wrap.clientWidth,
      wrap.clientHeight,
      Math.min(2, window.devicePixelRatio || 1)
    )
  measure()
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
  observer?.observe(wrap)
  return () => observer?.disconnect()
}

/** Pausa el bucle fuera de pantalla o con la pestaña oculta. */
function watchPresence(engine: ConstellationEngine, wrap: HTMLElement) {
  let inView = true
  const sync = () =>
    engine.setActive(inView && document.visibilityState !== 'hidden')
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(([entry]) => {
          inView = entry?.isIntersecting ?? true
          sync()
        })
  observer?.observe(wrap)
  document.addEventListener('visibilitychange', sync)
  return () => {
    observer?.disconnect()
    document.removeEventListener('visibilitychange', sync)
  }
}

/** Crea el motor sobre el lienzo y lo mantiene al día con el modelo y la vista. */
export function useConstellationEngine({
  canvasRef,
  wrapRef,
  model,
  reduced,
  onHover,
  view,
}: Options) {
  const engineRef = useRef<ConstellationEngine | null>(null)
  const hoverRef = useRef(onHover)
  const lastSelected = useRef<string | null>(null)
  const lastFly = useRef(0)
  useEffect(() => {
    hoverRef.current = onHover
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const engine = new ConstellationEngine(canvas, {
      reduced,
      font: getComputedStyle(wrap).fontFamily || 'sans-serif',
      onHover: (index, x, y) =>
        hoverRef.current(index >= 0 ? { index, x, y } : null),
    })
    engineRef.current = engine
    const stopSize = watchSize(engine, wrap)
    const stopPresence = watchPresence(engine, wrap)
    return () => {
      stopSize()
      stopPresence()
      engine.destroy()
      engineRef.current = null
    }
  }, [canvasRef, wrapRef, reduced])

  useEffect(() => {
    engineRef.current?.setModel(model, { intro: true })
    lastSelected.current = null
  }, [model, reduced])

  const {
    day,
    hidden,
    focusIds,
    selectedId,
    keyFocus,
    insetLeft,
    insetRight,
    flyTo,
  } = view
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const toIndex = (id: string | null) =>
      id ? (model.index.get(id) ?? -1) : -1
    const focus = focusIds
      ? new Set(
          [...focusIds]
            .map(id => model.index.get(id))
            .filter((i): i is number => i !== undefined)
        )
      : null
    engine.setView({
      day,
      hidden,
      focus,
      selected: toIndex(selectedId),
      keyFocus,
      insetLeft,
      insetRight,
    })
    if (flyTo && flyTo.seq !== lastFly.current)
      engine.focusNode(toIndex(flyTo.id))
    else if (selectedId && selectedId !== lastSelected.current)
      engine.ensureVisible(toIndex(selectedId))
    lastFly.current = flyTo?.seq ?? lastFly.current
    lastSelected.current = selectedId
  }, [
    model,
    reduced,
    day,
    hidden,
    focusIds,
    selectedId,
    keyFocus,
    insetLeft,
    insetRight,
    flyTo,
  ])

  return engineRef
}
