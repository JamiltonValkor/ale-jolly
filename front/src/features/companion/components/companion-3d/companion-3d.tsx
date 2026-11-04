'use client'

import dynamic from 'next/dynamic'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from 'react'

import { cn } from '@/lib/utils'

import { CompanionFallback } from './companion-fallback'
import type {
  CompanionAction,
  CompanionMood,
  PointDirection,
} from './rig/companion-moods'
import { resolveRenderQuality } from './rig/render-quality'
import type { CompanionSceneApi } from './scene/companion-scene'
import type { SayOptions } from './speech/speech-player'
import { useCompanionSpeech, type SayProp } from './use-companion-speech'
import type { CompanionSceneStatus } from './use-companion-scene'
import { useDemoReel } from './use-demo-reel'
import { useElementSize } from './use-element-size'
import { usePrefersReducedMotion } from './use-prefers-reduced-motion'

/** three y la escena viven en un chunk aparte: nunca entran al bundle inicial. */
const Companion3DCanvas = dynamic(
  () => import('./companion-3d-canvas').then(m => m.Companion3DCanvas),
  { ssr: false }
)

export interface PlayOptions {
  /** Para `present`: hacia qué lado señala. */
  direction?: 'left' | 'right'
}

export interface CompanionHandle {
  /** Acción puntual (saludar, asentir, girar, sorpresa…). */
  play(action: CompanionAction, opts?: PlayOptions): void
  /** Dice un texto moviendo la boca (lip-sync); con `voice` también suena. Resuelve al terminar. */
  say(text: string, opts?: SayOptions): Promise<void>
  wave(): void
  nod(): void
  jump(): void
  wake(): void
}

interface Props {
  /** Estado persistente. */
  mood?: CompanionMood
  /** 0–1: apertura de la boca mientras habla. Sin valor = patrón automático. */
  speakingLevel?: number
  /** Ojos y cabeza siguen al puntero en toda la página. */
  followPointer?: boolean
  /** Te nota al acercarte, se ríe al rozarlo, reacciona distinto a cada toque, se duerme si lo ignoras. */
  interactive?: boolean
  /** Recorre todos los estados y acciones (demo / laboratorio). */
  autoplay?: boolean
  /** Hacia dónde señala en `presenting` y `present`. */
  pointTo?: 'left' | 'right'
  /** Semilla del azar: mismos parpadeos y gestos en cada carga (capturas). */
  seed?: number
  /** 'head' = primer plano de la capucha (retrato tipo Muse); sin brazos ni pies. */
  framing?: 'full' | 'head'
  /** Decir un texto (un `nonce` nuevo lo repite). `voice: true` usa la voz del navegador. */
  say?: SayProp
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
  /** Nombre accesible (role="img"); el texto lo traduce quien lo usa. */
  label: string
  className?: string
  /** Primer frame WebGL dibujado, o respaldo SVG listo si no hay WebGL. */
  onReady?: () => void
  ref?: Ref<CompanionHandle>
}

const toDirection = (side?: 'left' | 'right'): PointDirection =>
  side === 'left' ? -1 : 1

function useCompanionHandle(
  ref: Ref<CompanionHandle> | undefined,
  apiRef: RefObject<CompanionSceneApi | null>,
  say: CompanionHandle['say']
) {
  const [fallbackAction, setFallbackAction] = useState<{
    kind: CompanionAction
    nonce: number
  } | null>(null)
  const play = useCallback(
    (kind: CompanionAction, opts?: PlayOptions) => {
      const direction = opts?.direction
        ? toDirection(opts.direction)
        : undefined
      if (apiRef.current) apiRef.current.play(kind, { direction })
      else setFallbackAction(g => ({ kind, nonce: (g?.nonce ?? 0) + 1 }))
    },
    [apiRef]
  )
  useImperativeHandle(
    ref,
    () => ({
      play,
      say,
      wave: () => play('wave'),
      nod: () => play('nod'),
      jump: () => play('jump'),
      wake: () => play('wake'),
    }),
    [play, say]
  )
  return { play, fallbackAction }
}

export function Companion3D({
  mood = 'idle',
  speakingLevel,
  followPointer = false,
  interactive = false,
  autoplay = false,
  pointTo,
  seed,
  framing = 'full',
  say: sayProp,
  onSpeechStart,
  onSpeechEnd,
  label,
  className,
  onReady,
  ref,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<CompanionSceneApi | null>(null)
  const size = useElementSize(containerRef)
  const reducedMotion = usePrefersReducedMotion()
  const [status, setStatus] = useState<CompanionSceneStatus>('loading')
  const speech = useCompanionSpeech(sayProp, { onSpeechStart, onSpeechEnd })
  const { play, fallbackAction } = useCompanionHandle(ref, apiRef, speech.say)
  const reelMood = useDemoReel(autoplay, play)
  // Mientras habla, actúa como «speaking»; al terminar vuelve a su ánimo.
  const activeMood = speech.speaking ? 'speaking' : (reelMood ?? mood)
  const shownFraming = size
    ? resolveRenderQuality(size.width, size.height, 1, framing).framing
    : framing

  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])
  useEffect(() => {
    if (status !== 'loading') onReadyRef.current?.()
  }, [status])

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      data-mood={activeMood}
      data-status={status}
      className={cn(
        'relative size-full',
        interactive && 'cursor-pointer',
        className
      )}
    >
      <CompanionFallback
        mood={activeMood}
        framing={shownFraming}
        reducedMotion={reducedMotion}
        gesture={fallbackAction}
        className={cn(
          'absolute inset-0 transition-opacity duration-300 ease-out',
          status === 'ready' && 'opacity-0'
        )}
      />
      {status !== 'failed' && (
        <Companion3DCanvas
          key={framing}
          framing={framing}
          visemeSource={speech.visemeSource}
          mood={activeMood}
          speakingLevel={speakingLevel}
          followPointer={followPointer}
          interactive={interactive}
          seed={seed}
          direction={toDirection(pointTo)}
          reducedMotion={reducedMotion}
          size={size}
          apiRef={apiRef}
          onStatus={setStatus}
        />
      )}
    </div>
  )
}
