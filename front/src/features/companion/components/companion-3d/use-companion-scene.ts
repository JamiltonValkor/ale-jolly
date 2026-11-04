'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

import type { CompanionMood, PointDirection } from './rig/companion-moods'
import { normalizePointer } from './rig/pointer'
import {
  resolveRenderQuality,
  type RequestedFraming,
} from './rig/render-quality'
import type { VisemeShape } from './speech/lipsync'
import { CompanionScene, type CompanionSceneApi } from './scene/companion-scene'

export type CompanionSceneStatus = 'loading' | 'ready' | 'failed'

export interface CompanionSceneOptions {
  mood: CompanionMood
  speakingLevel?: number | null
  /** Ojos y cabeza siguen al puntero. */
  followPointer: boolean
  /** Te nota, se ríe al rozarlo, reacciona distinto a cada toque, se duerme si lo ignoras. */
  interactive?: boolean
  reducedMotion: boolean
  size: { width: number; height: number } | null
  seed?: number
  direction?: PointDirection
  /** Fijo al montar (quien lo usa remonta el lienzo si cambia). */
  framing?: RequestedFraming
  /** Visema actual del lip-sync. */
  visemeSource?: () => VisemeShape | null
}

function supportsWebGL2(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.WebGL2RenderingContext !== 'undefined'
  )
}

/** Crea la escena en un lienzo propio dentro del contenedor y la libera al desmontar. */
function useSceneLifecycle(
  containerRef: RefObject<HTMLDivElement | null>,
  initial: CompanionSceneOptions,
  setStatus: (s: CompanionSceneStatus) => void
) {
  const sceneRef = useRef<CompanionSceneApi | null>(null)
  const initialRef = useRef(initial)
  useEffect(() => {
    const container = containerRef.current
    if (!container || !supportsWebGL2()) {
      setStatus('failed')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.className = 'block size-full'
    canvas.setAttribute('aria-hidden', 'true')
    container.appendChild(canvas)
    let scene: CompanionSceneApi | null = null
    try {
      const o = initialRef.current
      scene = new CompanionScene(canvas, {
        mood: o.mood,
        reducedMotion: o.reducedMotion,
        speakingLevel: o.speakingLevel,
        seed: o.seed,
        interactive: o.interactive,
        direction: o.direction,
        framing: o.framing,
        onFirstFrame: () => setStatus('ready'),
        onContextLost: () => setStatus('failed'),
      })
    } catch {
      canvas.remove()
      setStatus('failed')
      return
    }
    sceneRef.current = scene
    const io = new IntersectionObserver(([entry]) =>
      scene?.setVisible(entry.isIntersecting)
    )
    io.observe(container)
    return () => {
      io.disconnect()
      scene?.dispose()
      sceneRef.current = null
      canvas.remove()
    }
  }, [containerRef, setStatus])
  return sceneRef
}

/** El personaje sigue al puntero en toda la página («que te persiga»). */
function usePointerFollow(
  containerRef: RefObject<HTMLDivElement | null>,
  sceneRef: RefObject<CompanionSceneApi | null>,
  enabled: boolean,
  size: CompanionSceneOptions['size'],
  requested: RequestedFraming
) {
  useEffect(() => {
    const scene = sceneRef.current
    if (!enabled || !scene) {
      scene?.setPointer(null)
      return
    }
    const framing = resolveRenderQuality(
      size?.width ?? 300,
      size?.height ?? 300,
      1,
      requested
    ).framing
    const onMove = (e: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const radius = Math.max(Math.min(rect.width, rect.height) / 2, 1)
      const dx = e.clientX - (rect.left + rect.width / 2)
      const dy = e.clientY - (rect.top + rect.height / 2)
      const p = normalizePointer(e.clientX, e.clientY, rect, viewport, framing)
      sceneRef.current?.setPointer({
        ...p,
        distance: Math.hypot(dx, dy) / radius,
      })
    }
    const onLeave = () => sceneRef.current?.setPointer(null)
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [containerRef, sceneRef, enabled, size, requested])
}

/** Interactivo: roce (risita y rubor) y toque (un movimiento distinto cada vez). */
function useTouchReactions(
  containerRef: RefObject<HTMLDivElement | null>,
  sceneRef: RefObject<CompanionSceneApi | null>,
  enabled: boolean
) {
  useEffect(() => {
    const el = containerRef.current
    sceneRef.current?.setInteractive(enabled)
    if (!el || !enabled) return
    const enter = () => sceneRef.current?.pointerEnter()
    const leave = () => sceneRef.current?.pointerLeave()
    const click = () => sceneRef.current?.pointerClick()
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('click', click)
    return () => {
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('click', click)
    }
  }, [containerRef, sceneRef, enabled])
}

export function useCompanionScene(
  containerRef: RefObject<HTMLDivElement | null>,
  options: CompanionSceneOptions
) {
  const [status, setStatus] = useState<CompanionSceneStatus>('loading')
  const sceneRef = useSceneLifecycle(containerRef, options, setStatus)
  const {
    mood,
    speakingLevel,
    reducedMotion,
    followPointer,
    interactive = false,
    size,
    direction = 1,
  } = options
  const { framing = 'full', visemeSource } = options
  useEffect(
    () => sceneRef.current?.setVisemeSource(visemeSource ?? null),
    [sceneRef, visemeSource]
  )
  useEffect(() => sceneRef.current?.setMood(mood), [sceneRef, mood])
  useEffect(
    () => sceneRef.current?.setSpeakingLevel(speakingLevel),
    [sceneRef, speakingLevel]
  )
  useEffect(
    () => sceneRef.current?.setReducedMotion(reducedMotion),
    [sceneRef, reducedMotion]
  )
  useEffect(
    () => sceneRef.current?.setDirection(direction),
    [sceneRef, direction]
  )
  useEffect(() => {
    if (size) sceneRef.current?.resize(size.width, size.height)
  }, [sceneRef, size])
  usePointerFollow(
    containerRef,
    sceneRef,
    (followPointer || interactive) && !reducedMotion,
    size,
    framing
  )
  useTouchReactions(containerRef, sceneRef, interactive)
  return { status, sceneRef }
}
