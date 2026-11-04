'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface Options {
  total: number
  day: number
  onDay: (day: number) => void
  stepMs?: number
}

/**
 * «Reproducir crecimiento»: avanza un día por paso hasta hoy. Si ya estaba
 * en hoy, empieza desde el día 1. Mover el deslizador a mano lo pausa.
 */
export function useGrowthPlayback({
  total,
  day,
  onDay,
  stepMs = 720,
}: Options) {
  const [playing, setPlaying] = useState(false)
  const dayRef = useRef(day)
  const onDayRef = useRef(onDay)
  useEffect(() => {
    dayRef.current = day
    onDayRef.current = onDay
  })

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const next = dayRef.current + 1
      if (next > total) {
        setPlaying(false)
        return
      }
      dayRef.current = next
      onDayRef.current(next)
    }, stepMs)
    return () => clearInterval(timer)
  }, [playing, total, stepMs])

  const toggle = useCallback(() => {
    if (!playing && dayRef.current >= total) {
      dayRef.current = 1
      onDayRef.current(1)
    }
    setPlaying(!playing)
  }, [playing, total])

  const stop = useCallback(() => setPlaying(false), [])

  return { playing, toggle, stop }
}
