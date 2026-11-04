'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { VisemeShape } from './speech/lipsync'
import { SpeechPlayer, type SayOptions } from './speech/speech-player'

export interface SayProp extends SayOptions {
  text: string
  /** Un nonce nuevo = decirlo otra vez. */
  nonce: number
}

interface Callbacks {
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
}

/**
 * Habla del compañero: `say()` imperativo y prop declarativa. Devuelve si
 * está hablando y una fuente estable del visema actual para la escena 3D.
 */
export function useCompanionSpeech(
  sayProp: SayProp | undefined,
  callbacks: Callbacks
) {
  const [speaking, setSpeaking] = useState(false)
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  }, [callbacks])
  const playerRef = useRef<SpeechPlayer | null>(null)

  const getPlayer = useCallback(() => {
    playerRef.current ??= new SpeechPlayer({
      onStart: () => {
        setSpeaking(true)
        callbacksRef.current.onSpeechStart?.()
      },
      onEnd: () => {
        setSpeaking(false)
        callbacksRef.current.onSpeechEnd?.()
      },
    })
    return playerRef.current
  }, [])

  const say = useCallback(
    (text: string, opts?: SayOptions) => getPlayer().say(text, opts),
    [getPlayer]
  )
  const visemeSource = useCallback(
    (): VisemeShape | null => playerRef.current?.sample() ?? null,
    []
  )

  useEffect(() => () => playerRef.current?.cancel(), [])

  const nonce = sayProp?.nonce
  useEffect(() => {
    if (!sayProp || nonce === undefined) return
    void say(sayProp.text, { voice: sayProp.voice, lang: sayProp.lang })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando cambia el nonce
  }, [nonce, say])

  return { speaking, say, visemeSource }
}
