'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  /** Movimiento reducido: sin conteo. */
  reduced?: boolean
  locale?: string
  duration?: number
  prefix?: string
  className?: string
}

export function tweenValue(from: number, to: number, t: number): number {
  const eased = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
  return Math.round(from + (to - from) * eased)
}

/**
 * Cifra que cuenta hasta su valor (al aparecer y cada vez que cambia). El
 * número animado es decorativo: quien lo usa deja el valor final para el
 * lector de pantalla.
 */
export function AnimatedNumber({
  value,
  reduced,
  locale = 'es-CO',
  duration = 900,
  prefix = '',
  className,
}: Props) {
  // Siempre empieza en 0 (igual en servidor y cliente); con movimiento reducido salta al valor.
  const [shown, setShown] = useState(0)
  const from = useRef(0)

  useEffect(() => {
    if (reduced) {
      from.current = value
      setShown(value)
      return
    }
    const start = performance.now()
    const origin = from.current
    let frame = requestAnimationFrame(function step(now) {
      const t = (now - start) / duration
      const next = tweenValue(origin, value, t)
      from.current = next
      setShown(next)
      if (t < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [value, reduced, duration])

  return (
    <span className={className} aria-hidden="true">
      {prefix}
      {shown.toLocaleString(locale)}
    </span>
  )
}
