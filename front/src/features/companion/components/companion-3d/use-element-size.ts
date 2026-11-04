'use client'

import { useEffect, useState, type RefObject } from 'react'

export interface ElementSize {
  width: number
  height: number
}

/** Tamaño del elemento en px enteros (ResizeObserver). null hasta medir. */
export function useElementSize(
  ref: RefObject<HTMLElement | null>
): ElementSize | null {
  const [size, setSize] = useState<ElementSize | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      setSize(prev =>
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height }
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}
