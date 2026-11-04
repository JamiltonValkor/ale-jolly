/**
 * Voz del navegador para la cara 2D (respaldo del personaje 3D). Solo se usa
 * tras un gesto de la persona («Probar: dile hola»): sin gesto, el navegador
 * no deja sonar nada y la boca se mueve en silencio.
 */

export interface SpeechSynthesisLike {
  cancel(): void
  speak(utterance: SpeechSynthesisUtterance): void
  getVoices(): SpeechSynthesisVoice[]
}

type UtteranceConstructor = new (text: string) => {
  lang: string
  rate: number
  pitch: number
  voice: SpeechSynthesisVoice | null
}

const LATAM = ['es-419', 'es-MX', 'es-US', 'es-CO', 'es-AR', 'es-CL', 'es-PE']

export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  locale: string
): SpeechSynthesisVoice | null {
  if (locale === 'en') return voices.find(v => v.lang.startsWith('en')) ?? null
  return (
    voices.find(v => LATAM.includes(v.lang)) ??
    voices.find(v => v.lang.startsWith('es')) ??
    null
  )
}

function defaultSynth(): SpeechSynthesisLike | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null
}

function defaultUtterance(): UtteranceConstructor | null {
  return typeof window !== 'undefined' && 'SpeechSynthesisUtterance' in window
    ? window.SpeechSynthesisUtterance
    : null
}

/** Dice el texto en voz alta; devuelve si pudo. */
export function speakAloud(
  text: string,
  locale: string,
  synth: SpeechSynthesisLike | null = defaultSynth(),
  Utterance: UtteranceConstructor | null = defaultUtterance()
): boolean {
  if (!synth || !Utterance || !text.trim()) return false
  synth.cancel()
  const utterance = new Utterance(text)
  utterance.lang = locale === 'en' ? 'en-US' : 'es-419'
  utterance.rate = 1.02
  utterance.pitch = 1.18
  utterance.voice = pickVoice(synth.getVoices(), locale)
  synth.speak(utterance as SpeechSynthesisUtterance)
  return true
}
