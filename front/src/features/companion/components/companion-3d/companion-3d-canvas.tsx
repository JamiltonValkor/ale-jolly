'use client'

import { useEffect, useRef, type RefObject } from 'react'

import { cn } from '@/lib/utils'

import type { CompanionMood, PointDirection } from './rig/companion-moods'
import type { RequestedFraming } from './rig/render-quality'
import type { VisemeShape } from './speech/lipsync'
import type { CompanionSceneApi } from './scene/companion-scene'
import {
  useCompanionScene,
  type CompanionSceneStatus,
} from './use-companion-scene'

/**
 * Lienzo WebGL del compañero. Este módulo (y three) solo se carga en el
 * cliente, de forma diferida, desde `Companion3D`.
 */

interface Props {
  mood: CompanionMood
  speakingLevel?: number | null
  followPointer: boolean
  interactive?: boolean
  seed?: number
  direction?: PointDirection
  framing?: RequestedFraming
  visemeSource?: () => VisemeShape | null
  reducedMotion: boolean
  size: { width: number; height: number } | null
  apiRef: RefObject<CompanionSceneApi | null>
  onStatus: (status: CompanionSceneStatus) => void
  className?: string
}

export function Companion3DCanvas({
  apiRef,
  onStatus,
  className,
  ...options
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { status, sceneRef } = useCompanionScene(containerRef, options)

  useEffect(() => {
    apiRef.current = status === 'failed' ? null : sceneRef.current
    onStatus(status)
    return () => {
      apiRef.current = null
    }
  }, [apiRef, onStatus, sceneRef, status])

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute inset-0 transition-opacity duration-700 ease-[cubic-bezier(.22,1,.36,1)]',
        status === 'ready' ? 'opacity-100' : 'opacity-0',
        className
      )}
    />
  )
}
