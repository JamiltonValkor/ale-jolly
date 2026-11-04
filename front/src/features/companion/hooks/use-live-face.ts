'use client'

import { useCallback, useEffect, useState } from 'react'

import type { SayLine } from '../components/face/face-mouth'
import { isFaceState, type FaceState } from '../lib/face-state'
import { buildVisemeTimeline, visemeDuration } from '../lib/viseme-timeline'

/**
 * Cara en vivo del robot. El software de Jamilton la maneja con
 *   window.postMessage({ source: 'saleads-companion', face: 'speaking', amplitude: 0.6 }, '*')
 *   window.postMessage({ source: 'saleads-companion', say: '¡Hola, Nicolás!' }, '*')
 * En demo (sin ese software) recorre una conversación sola, saluda con su
 * frase cuando desde Saleads tocan «Probar: dile hola» y acepta teclas.
 */

export const LIVE_FACE_MESSAGE_SOURCE = 'saleads-companion'

interface Beat {
  face: FaceState
  ms: number
  /** Frase con sincronía labial durante este tramo. */
  say?: string
}

const CONVERSATION: Beat[] = [
  { face: 'idle', ms: 5200 },
  { face: 'listening', ms: 3000 },
  { face: 'thinking', ms: 1500 },
  { face: 'speaking', ms: 4200 },
]

/** Teclas del escenario (solo demo). */
const KEYS: Record<string, FaceState> = {
  i: 'idle',
  l: 'listening',
  t: 'thinking',
  s: 'speaking',
  h: 'happy',
  e: 'error',
  z: 'sleeping',
}

export interface LiveFace {
  face: FaceState
  amplitude?: number
  say?: SayLine
  /** Dice una frase moviendo la boca (cualquier modo). */
  speak: (text: string) => void
  /** Solo demo: escucha, saluda con su frase y se alegra. */
  greet?: () => void
}

function speechBeats(text: string, after: FaceState | null): Beat[] {
  const ms = Math.round(visemeDuration(buildVisemeTimeline(text)) * 1000) + 250
  const speaking: Beat = { face: 'speaking', ms, say: text }
  return after ? [speaking, { face: after, ms: 1800 }] : [speaking]
}

type Message = { face: FaceState; amplitude?: number } | { say: string }

function readMessage(data: unknown): Message | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.source !== LIVE_FACE_MESSAGE_SOURCE) return null
  if (typeof message.say === 'string' && message.say.trim())
    return { say: message.say.slice(0, 400) }
  if (!isFaceState(message.face)) return null
  const amplitude =
    typeof message.amplitude === 'number' ? message.amplitude : undefined
  return amplitude === undefined
    ? { face: message.face }
    : { face: message.face, amplitude }
}

/** Reproduce tramos de caras; al terminar vuelve a la conversación (demo) o a reposo. */
function useScript(running: boolean, conversation: boolean) {
  const [script, setScript] = useState({
    beats: conversation ? CONVERSATION : [],
    index: 0,
    id: 0,
  })
  const beat = script.beats[script.index]
  useEffect(() => {
    if (!running || !beat) return
    const timer = setTimeout(() => {
      setScript(current => {
        const next = current.index + 1
        if (next < current.beats.length) return { ...current, index: next }
        return {
          beats: conversation ? CONVERSATION : [],
          index: 0,
          id: current.id + 1,
        }
      })
    }, beat.ms)
    return () => clearTimeout(timer)
  }, [running, beat, script, conversation])
  const play = useCallback(
    (beats: Beat[]) =>
      setScript(current => ({ beats, index: 0, id: current.id + 1 })),
    []
  )
  return {
    beat: running ? beat : undefined,
    nonce: script.id * 100 + script.index + 1,
    play,
  }
}

/** postMessage (siempre en vivo) y teclas del escenario (solo demo). */
function useLiveInputs(
  active: boolean,
  demo: boolean,
  play: (beats: Beat[]) => void,
  setExternal: (value: { face: FaceState; amplitude?: number } | null) => void
) {
  useEffect(() => {
    if (!active) return
    const onMessage = (event: MessageEvent) => {
      const message = readMessage(event.data)
      if (!message) return
      if ('say' in message) play(speechBeats(message.say, null))
      else setExternal(message)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [active, play, setExternal])

  useEffect(() => {
    if (!active || !demo) return
    const onKey = (event: KeyboardEvent) => {
      const face = KEYS[event.key.toLowerCase()]
      if (face) play([{ face, ms: 6000 }])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, demo, play])
}

export function useLiveFace({
  active,
  demo,
  greeting,
}: {
  active: boolean
  demo: boolean
  /** Lo que dice al saludar (demo, «Probar: dile hola»). */
  greeting?: string
}): LiveFace {
  const [external, setExternal] = useState<{
    face: FaceState
    amplitude?: number
  } | null>(null)
  const { beat, nonce, play } = useScript(active, demo)
  useLiveInputs(active, demo, play, setExternal)

  const speak = useCallback(
    (text: string) => play(speechBeats(text, null)),
    [play]
  )
  const greet = useCallback(() => {
    const hello: Beat[] = greeting
      ? speechBeats(greeting, 'happy')
      : [
          { face: 'speaking', ms: 3400 },
          { face: 'happy', ms: 1800 },
        ]
    play([{ face: 'listening', ms: 1100 }, ...hello])
  }, [play, greeting])

  if (!active) return { face: 'idle', speak }
  const extra = demo ? { speak, greet } : { speak }
  if (beat?.say)
    return { face: 'speaking', say: { text: beat.say, nonce }, ...extra }
  if (external) return { ...external, ...extra }
  return { face: beat?.face ?? 'idle', ...extra }
}
