'use client'

import { useEffect, useRef, useState } from 'react'

type Point = { x: number; y: number }

const CENTER: Point = { x: 0, y: 0 }

/** Puntos a los que mira en reposo (unidades del viewBox); el centro pesa doble. */
const LOOKS: readonly Point[] = [
  CENTER,
  CENTER,
  { x: -6, y: -2 },
  { x: 6, y: -2 },
  { x: -5, y: 3 },
  { x: 5, y: 3 },
  { x: 0, y: -4 },
]

/** `random` se inyecta para probar; se lee por ref para no reiniciar efectos. */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}

/**
 * Parpadeo natural: cada 2,3–6 s, a veces doble. Devuelve si el ojo está
 * cerrado ahora.
 */
export function useBlink(
  enabled: boolean,
  random: () => number = Math.random
): boolean {
  const [closed, setClosed] = useState(false)
  const randomRef = useLatest(random)

  useEffect(() => {
    if (!enabled) {
      setClosed(false)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const blink = (then: () => void) => {
      setClosed(true)
      timer = setTimeout(() => {
        setClosed(false)
        then()
      }, 130)
    }
    const schedule = () => {
      timer = setTimeout(
        () => {
          const double = randomRef.current() > 0.8
          blink(() => {
            if (double) timer = setTimeout(() => blink(schedule), 170)
            else schedule()
          })
        },
        2300 + randomRef.current() * 3700
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }, [enabled, randomRef])

  return closed
}

/** Mirada que pasea en reposo: cambia de punto cada 2,4–5 s. */
export function useWander(
  enabled: boolean,
  random: () => number = Math.random
): Point {
  const [look, setLook] = useState<Point>(CENTER)
  const randomRef = useLatest(random)

  useEffect(() => {
    if (!enabled) {
      setLook(CENTER)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(
        () => {
          const index = Math.floor(randomRef.current() * LOOKS.length)
          setLook(LOOKS[index] ?? CENTER)
          next()
        },
        2400 + randomRef.current() * 2600
      )
    }
    next()
    return () => clearTimeout(timer)
  }, [enabled, randomRef])

  return enabled ? look : CENTER
}
