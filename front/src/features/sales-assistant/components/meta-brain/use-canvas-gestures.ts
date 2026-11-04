'use client'

import {
  useEffect,
  useMemo,
  useRef,
  type PointerEvent,
  type RefObject,
} from 'react'

/** Lo que los gestos necesitan del motor (así se prueban con un doble). */
export interface GestureTarget {
  hitAt: (sx: number, sy: number) => number
  setHover: (index: number) => void
  panBy: (dx: number, dy: number) => void
  zoomBy: (factor: number, sx?: number, sy?: number, animate?: boolean) => void
}

interface Callbacks {
  onTap: (index: number) => void
  onEngage: () => void
  onDragChange?: (dragging: boolean) => void
}

interface Point {
  x: number
  y: number
}

const TAP_SLOP = 5

function local(element: HTMLElement | null, x: number, y: number): Point {
  const rect = element?.getBoundingClientRect()
  return { x: x - (rect?.left ?? 0), y: y - (rect?.top ?? 0) }
}

function pinchOf(points: Point[]) {
  const [a, b] = points
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
  }
}

/**
 * Arrastrar para mover, rueda y pellizco para acercar, toque para elegir,
 * cursor para el hover. La rueda se escucha sin `passive` para que no
 * desplace la página mientras se acerca el grafo.
 */
export function useCanvasGestures(
  ref: RefObject<HTMLElement | null>,
  engineRef: RefObject<GestureTarget | null>,
  callbacks: Callbacks
) {
  const pointers = useRef(new Map<number, Point>())
  const start = useRef<Point | null>(null)
  const dragging = useRef(false)
  const pinch = useRef<{ mid: Point; dist: number } | null>(null)
  const latest = useRef(callbacks)
  useEffect(() => {
    latest.current = callbacks
  })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 32 : 1
      const p = local(element, event.clientX, event.clientY)
      engineRef.current?.zoomBy(
        Math.exp(-event.deltaY * unit * 0.0018),
        p.x,
        p.y,
        false
      )
      latest.current.onEngage()
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [ref, engineRef])

  return useMemo(() => {
    const setDragging = (value: boolean) => {
      if (dragging.current === value) return
      dragging.current = value
      latest.current.onDragChange?.(value)
    }
    const movePinch = () => {
      const next = pinchOf([...pointers.current.values()])
      const prev = pinch.current ?? next
      engineRef.current?.zoomBy(
        next.dist / prev.dist,
        next.mid.x,
        next.mid.y,
        false
      )
      engineRef.current?.panBy(next.mid.x - prev.mid.x, next.mid.y - prev.mid.y)
      pinch.current = next
    }
    return {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 && event.pointerType === 'mouse') return
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        } catch {
          // Algunos navegadores rechazan capturar un puntero sintético.
        }
        const p = local(ref.current, event.clientX, event.clientY)
        pointers.current.set(event.pointerId, p)
        start.current = pointers.current.size === 1 ? p : null
        pinch.current =
          pointers.current.size === 2
            ? pinchOf([...pointers.current.values()])
            : null
        latest.current.onEngage()
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const p = local(ref.current, event.clientX, event.clientY)
        const previous = pointers.current.get(event.pointerId)
        if (!previous) {
          if (event.pointerType !== 'touch')
            engineRef.current?.setHover(engineRef.current.hitAt(p.x, p.y))
          return
        }
        pointers.current.set(event.pointerId, p)
        if (pointers.current.size >= 2) return movePinch()
        const origin = start.current
        if (origin && Math.hypot(p.x - origin.x, p.y - origin.y) > TAP_SLOP)
          setDragging(true)
        if (dragging.current) {
          engineRef.current?.setHover(-1)
          engineRef.current?.panBy(p.x - previous.x, p.y - previous.y)
        }
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        const p = local(ref.current, event.clientX, event.clientY)
        const wasTap =
          pointers.current.size === 1 &&
          !dragging.current &&
          start.current !== null
        pointers.current.delete(event.pointerId)
        if (wasTap)
          latest.current.onTap(engineRef.current?.hitAt(p.x, p.y) ?? -1)
        if (!pointers.current.size) {
          start.current = null
          pinch.current = null
          setDragging(false)
        }
      },
      onPointerCancel(event: PointerEvent<HTMLElement>) {
        pointers.current.delete(event.pointerId)
        if (!pointers.current.size) setDragging(false)
      },
      onPointerLeave(event: PointerEvent<HTMLElement>) {
        if (!pointers.current.has(event.pointerId))
          engineRef.current?.setHover(-1)
      },
    }
  }, [ref, engineRef])
}
