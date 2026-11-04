'use client'

import { useEffect, useRef, useState } from 'react'
import { splitChatQr } from '../../lib/chat-qr'
import { speakingMs } from '../../lib/meta-experience/choreography'
import type { MetaChatMessage } from './meta-chat-view'
import type { CompanionSayRequest } from './types'

interface Speaking {
  /** `true` mientras «dice» la última respuesta nueva. */
  speaking: boolean
  /** Lo que el compañero dice (la boca lo articula); `null` hasta la primera respuesta nueva. */
  say: CompanionSayRequest | null
}

/**
 * El compañero dice cada respuesta nueva (no el historial al abrir): pide que
 * la articule y marca «hablando» en proporción al texto.
 */
export function useCompanionSpeaking(messages: MetaChatMessage[]): Speaking {
  const last = [...messages]
    .reverse()
    .find(message => message.role === 'assistant')
  const seen = useRef<string | null | undefined>(undefined)
  const [state, setState] = useState<Speaking>({ speaking: false, say: null })
  const lastId = last?.id ?? null
  // El QR se ve, no se dice.
  const lastText = splitChatQr(last?.text ?? '')
    .flatMap(segment => (segment.kind === 'text' ? [segment.text] : []))
    .join('\n')
    .trim()
  useEffect(() => {
    if (seen.current === undefined) {
      seen.current = lastId
      return
    }
    if (lastId === null || lastId === seen.current) return
    seen.current = lastId
    if (!lastText) return
    setState(prev => ({
      speaking: true,
      say: { text: lastText, nonce: (prev.say?.nonce ?? 0) + 1 },
    }))
    const id = window.setTimeout(
      () => setState(prev => ({ ...prev, speaking: false })),
      speakingMs(lastText)
    )
    return () => window.clearTimeout(id)
  }, [lastId, lastText])
  return state
}
