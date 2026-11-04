import {
  buildVisemeTimeline,
  CLOSED,
  sampleVisemes,
  timeForChar,
  type VisemeShape,
  type VisemeTimeline,
} from './lipsync'

/**
 * Reproduce una línea de visemas en el tiempo. Con `voice: true` usa la Web
 * Speech API: arranca en el evento `start`, se resincroniza en cada palabra
 * (`boundary`) y termina en `end`. Si no hay voz o está bloqueada, la boca
 * se anima igual solo con la línea de tiempo. Nunca habla sin que quien lo
 * usa lo pida (el gesto del usuario lo decide él).
 */

export type SpeechLang = 'es-CO' | 'en-US'

export interface SayOptions {
  voice?: boolean
  lang?: SpeechLang
}

interface UtteranceLike {
  lang: string
  voice: SpeechSynthesisVoice | null
  rate: number
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  onboundary: ((e: { charIndex: number; name?: string }) => void) | null
}

interface SynthLike {
  speak(u: UtteranceLike): void
  cancel(): void
  getVoices(): SpeechSynthesisVoice[]
}

export interface SpeechDeps {
  now: () => number
  synth: SynthLike | null
  createUtterance: ((text: string) => UtteranceLike) | null
}

const VOICE_START_TIMEOUT_MS = 1500

function browserDeps(): SpeechDeps {
  const hasWindow = typeof window !== 'undefined'
  const synth =
    hasWindow && 'speechSynthesis' in window
      ? (window.speechSynthesis as unknown as SynthLike)
      : null
  const canUtter =
    hasWindow && typeof window.SpeechSynthesisUtterance === 'function'
  return {
    now: () =>
      typeof performance !== 'undefined' ? performance.now() : Date.now(),
    synth,
    createUtterance: canUtter
      ? text =>
          new window.SpeechSynthesisUtterance(text) as unknown as UtteranceLike
      : null,
  }
}

/** Voz en el idioma pedido (prefiere la variante exacta, luego el idioma). */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang: SpeechLang
): SpeechSynthesisVoice | null {
  const base = lang.slice(0, 2)
  return (
    voices.find(v => v.lang === lang) ??
    voices.find(v => v.lang.toLowerCase().startsWith(base)) ??
    null
  )
}

export class SpeechPlayer {
  private timeline: VisemeTimeline | null = null
  private startAt: number | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private resolve: (() => void) | null = null
  private usingVoice = false
  private readonly deps: SpeechDeps
  private readonly callbacks: { onStart?: () => void; onEnd?: () => void }

  constructor(
    callbacks: { onStart?: () => void; onEnd?: () => void } = {},
    deps: SpeechDeps = browserDeps()
  ) {
    this.callbacks = callbacks
    this.deps = deps
  }

  isSpeaking(): boolean {
    return this.timeline !== null
  }

  /** Visema actual, o null si no está hablando. */
  readonly sample = (): VisemeShape | null => {
    if (!this.timeline) return null
    if (this.startAt === null) return CLOSED
    return sampleVisemes(this.timeline, (this.deps.now() - this.startAt) / 1000)
  }

  say(text: string, opts: SayOptions = {}): Promise<void> {
    this.cancel()
    const timeline = buildVisemeTimeline(text)
    if (timeline.duration <= 0) return Promise.resolve()
    this.timeline = timeline
    this.callbacks.onStart?.()
    const done = new Promise<void>(resolve => {
      this.resolve = resolve
    })
    if (!(opts.voice && this.speakAloud(text, opts.lang ?? 'es-CO')))
      this.startTimeline()
    return done
  }

  cancel(): void {
    if (this.usingVoice) this.deps.synth?.cancel()
    this.finish()
  }

  private startTimeline() {
    if (!this.timeline) return
    this.startAt = this.deps.now()
    this.timers.push(
      setTimeout(() => this.finish(), this.timeline.duration * 1000 + 120)
    )
  }

  private speakAloud(text: string, lang: SpeechLang): boolean {
    const { synth, createUtterance } = this.deps
    if (!synth || !createUtterance) return false
    try {
      const u = createUtterance(text)
      u.lang = lang
      u.voice = pickVoice(synth.getVoices(), lang)
      u.rate = 1
      u.onstart = () => {
        if (this.startAt === null) this.startAt = this.deps.now()
      }
      u.onboundary = e => {
        if (this.timeline && (e.name === undefined || e.name === 'word')) {
          this.startAt =
            this.deps.now() - timeForChar(this.timeline, e.charIndex) * 1000
        }
      }
      u.onend = () => this.finish()
      u.onerror = () => this.finish()
      this.usingVoice = true
      synth.speak(u)
      this.timers.push(
        setTimeout(() => this.voiceDidNotStart(), VOICE_START_TIMEOUT_MS)
      )
      return true
    } catch {
      this.usingVoice = false
      return false
    }
  }

  /** Voz bloqueada o sin evento `start`: la boca sigue solo con la línea de tiempo. */
  private voiceDidNotStart() {
    if (this.timeline && this.startAt === null) this.startTimeline()
  }

  private finish() {
    this.timers.forEach(clearTimeout)
    this.timers = []
    const wasSpeaking = this.timeline !== null
    this.timeline = null
    this.startAt = null
    this.usingVoice = false
    const resolve = this.resolve
    this.resolve = null
    if (wasSpeaking) this.callbacks.onEnd?.()
    resolve?.()
  }
}
