/**
 * Dictado con el reconocimiento de voz del navegador (D4, E9-07/E9-08).
 *
 * Lógica pura portada de `origin/dummy/ale-neuronal:src/features/chat-v2/logic/voz.ts`.
 * Solo Chrome y Edge: Safari expone `webkitSpeechRecognition` pero su dictado
 * no es fiable, y Firefox no lo tiene; en ambos el botón Voz no aparece.
 */

/** Lo mínimo del reconocedor del navegador (no viene en `lib.dom`). */
export interface SpeechRecognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: DictationResultEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface DictationResultEvent {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}

export type SpeechRecognizerClass = new () => SpeechRecognizer

/** Por qué no se puede dictar; cada caso dice qué hacer. */
export type DictationBlock = 'permission' | 'microphone' | 'network'

interface DictationHost {
  navigator?: {
    userAgent?: string
    userAgentData?: { brands?: ReadonlyArray<{ brand: string }> }
  }
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
}

export function speechRecognitionClass(
  host: unknown
): SpeechRecognizerClass | null {
  if (!host || typeof host !== 'object') return null
  const { SpeechRecognition, webkitSpeechRecognition } = host as DictationHost
  const found = SpeechRecognition ?? webkitSpeechRecognition
  return typeof found === 'function' ? (found as SpeechRecognizerClass) : null
}

function isChromium(host: DictationHost) {
  const brands = host.navigator?.userAgentData?.brands
  if (brands?.some(({ brand }) => brand === 'Chromium')) return true
  // CriOS/EdgiOS (iOS) son WebKit por dentro y no llevan «Chrome/».
  return /(?:Chrome|Chromium|Edg)\/\d/.test(host.navigator?.userAgent ?? '')
}

export function dictationSupported(host: unknown) {
  if (!speechRecognitionClass(host)) return false
  return isChromium(host as DictationHost)
}

export function dictationBlockFor(error: string): DictationBlock | null {
  if (error === 'not-allowed' || error === 'service-not-allowed')
    return 'permission'
  if (error === 'audio-capture') return 'microphone'
  if (error === 'network') return 'network'
  // `no-speech` y `aborted`: el navegador cortó tras un silencio; se vuelve a escuchar.
  return null
}

/** Lo que ya quedó firme no se mueve; lo provisional va detrás. */
export function readDictationResults(
  settled: string,
  event: DictationResultEvent
) {
  let firm = settled
  let interim = ''
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i]
    if (result.isFinal) firm = `${firm} ${result[0].transcript}`.trim()
    else interim += result[0].transcript
  }
  return {
    settled: firm,
    text: `${firm} ${interim}`.replace(/\s+/g, ' ').trim(),
    done: !interim && !!firm,
  }
}

export function formatDictationTime(seconds: number) {
  const rest = String(seconds % 60).padStart(2, '0')
  return `${Math.floor(seconds / 60)}:${rest}`
}
