'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  dictationBlockFor,
  dictationSupported,
  readDictationResults,
  speechRecognitionClass,
  type DictationBlock,
  type SpeechRecognizer,
} from '../lib/speech-dictation'

type DictationStatus = 'listening' | 'paused' | 'blocked'

interface DictationView {
  status: DictationStatus
  block: DictationBlock | null
  text: string
  done: boolean
}

export interface SpeechDictation extends DictationView {
  seconds: number
  pause: () => void
  resume: () => void
}

const LISTENING: DictationView = {
  status: 'listening',
  block: null,
  text: '',
  done: false,
}

async function permissionDenied() {
  try {
    const status = await navigator.permissions?.query({
      name: 'microphone' as PermissionName,
    })
    return status?.state === 'denied'
  } catch {
    return false
  }
}

/**
 * Una sesión de dictado: escucha, vuelve a escuchar cuando el navegador corta
 * tras un silencio, y se detiene del todo si falta permiso, micrófono o red.
 */
function createDictationSession(
  lang: string,
  update: (change: (view: DictationView) => DictationView) => void
) {
  let recognizer: SpeechRecognizer | null = null
  let status: DictationStatus = 'listening'
  let settled = ''
  let disposed = false

  const release = (end: 'stop' | 'abort') => {
    const current = recognizer
    if (!current) return
    recognizer = null
    current.onend = null
    try {
      current[end]()
    } catch {
      /* ya estaba parado */
    }
  }
  const block = (reason: DictationBlock) => {
    release('stop')
    status = 'blocked'
    settled = ''
    update(() => ({ status, block: reason, text: '', done: false }))
  }
  const listen = () => {
    const Recognizer = speechRecognitionClass(window)
    if (disposed || !Recognizer || recognizer || status !== 'listening') return
    const current = new Recognizer()
    current.lang = lang
    current.continuous = true
    current.interimResults = true
    current.onresult = event => {
      const next = readDictationResults(settled, event)
      settled = next.settled
      update(view => ({ ...view, text: next.text, done: next.done }))
    }
    current.onerror = event => {
      const reason = dictationBlockFor(event.error)
      if (reason) block(reason)
    }
    current.onend = () => {
      if (recognizer !== current) return
      recognizer = null
      listen()
    }
    recognizer = current
    try {
      current.start()
    } catch {
      recognizer = null
    }
  }
  return {
    async begin() {
      // Ya negado: el navegador no vuelve a preguntar, así que se dice sin intentarlo.
      const denied = await permissionDenied()
      if (disposed) return
      if (denied) block('permission')
      else listen()
    },
    pause() {
      if (status !== 'listening') return
      status = 'paused'
      release('stop')
      update(view => ({ ...view, status }))
    },
    resume() {
      if (status !== 'paused') return
      status = 'listening'
      update(view => ({ ...view, status }))
      listen()
    },
    dispose() {
      disposed = true
      release('abort')
    },
  }
}

export function useSpeechDictation(lang = 'es-CO'): SpeechDictation {
  const [view, setView] = useState(LISTENING)
  const [seconds, setSeconds] = useState(0)
  const session = useRef<ReturnType<typeof createDictationSession>>(null)
  useEffect(() => {
    const current = createDictationSession(lang, setView)
    session.current = current
    void current.begin()
    return () => current.dispose()
  }, [lang])
  useEffect(() => {
    if (view.status !== 'listening') return
    const tick = setInterval(() => setSeconds(value => value + 1), 1000)
    return () => clearInterval(tick)
  }, [view.status])
  return {
    ...view,
    seconds,
    pause: () => session.current?.pause(),
    resume: () => session.current?.resume(),
  }
}

const subscribeNever = () => () => {}

/** Chrome y Edge con reconocedor; falso en el servidor para no desajustar la hidratación. */
export function useDictationSupported() {
  return useSyncExternalStore(
    subscribeNever,
    () => dictationSupported(window),
    () => false
  )
}
