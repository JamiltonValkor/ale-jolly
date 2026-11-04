'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  Companion3D,
  type CompanionHandle,
} from '@/features/companion/components/companion-3d/companion-3d'
import {
  COMPANION_ACTIONS,
  COMPANION_MOODS,
  isCompanionAction,
  isCompanionMood,
  type CompanionAction,
  type CompanionMood,
} from '@/features/companion/components/companion-3d/rig/companion-moods'
import { cn } from '@/lib/utils'
import { MetaUiScope } from '@/shared/meta-ui'

export type LabView = 'all' | 'hero' | 'card' | 'avatar'

interface Props {
  initialMood?: string
  view: LabView
  action?: string
  actionAt: number
  seed: number
  autoplay: boolean
  interactive: boolean
  follow: boolean
  pointTo: 'left' | 'right'
  simulatedPointer: { x: number; y: number } | null
  showControls: boolean
  heroSize: number
  framing: 'full' | 'head'
  sayText?: string
  sayAt: number
}

/** Puntero simulado para capturas sin mouse (solo laboratorio). */
function useSimulatedPointer(pointer: Props['simulatedPointer']) {
  useEffect(() => {
    if (!pointer) return
    const send = () =>
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: pointer.x * window.innerWidth,
          clientY: pointer.y * window.innerHeight,
        })
      )
    const id = window.setInterval(send, 400)
    return () => window.clearInterval(id)
  }, [pointer])
}

function Stage({
  size,
  label,
  children,
}: {
  size: number
  label: string
  children: ReactNode
}) {
  return (
    <figure className="flex flex-col items-center gap-3">
      <div style={{ width: size, height: size }}>{children}</div>
      <figcaption className="mu-label">{label}</figcaption>
    </figure>
  )
}

function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('mu-btn', on && 'mu-btn-p')}
    >
      {children}
    </button>
  )
}

export function Companion3DLab(props: Props) {
  const { view, showControls, heroSize } = props
  const [mood, setMood] = useState<CompanionMood>(
    isCompanionMood(props.initialMood) ? props.initialMood : 'idle'
  )
  const [follow, setFollow] = useState(props.follow)
  const [interactive, setInteractive] = useState(props.interactive)
  const [autoplay, setAutoplay] = useState(props.autoplay)
  const [pointTo, setPointTo] = useState(props.pointTo)
  const [speaking, setSpeaking] = useState<number | undefined>(undefined)
  const [framing, setFraming] = useState(props.framing)
  const [voice, setVoice] = useState(false)
  const [text, setText] = useState(
    props.sayText ??
      '¡Hola, Nicolás! Ya conozco tu negocio y tus ventas de esta semana.'
  )
  const [talking, setTalking] = useState(false)
  const sayAll = (t: string, withVoice: boolean) => {
    void heroRef.current?.say(t, { voice: withVoice, lang: 'es-CO' })
    void cardRef.current?.say(t)
    void avatarRef.current?.say(t)
  }
  const heroRef = useRef<CompanionHandle>(null)
  const cardRef = useRef<CompanionHandle>(null)
  const avatarRef = useRef<CompanionHandle>(null)
  const playAll = (a: CompanionAction) =>
    [heroRef, cardRef, avatarRef].forEach(r =>
      r.current?.play(a, { direction: pointTo })
    )
  useSimulatedPointer(props.simulatedPointer)

  const initialAction = props.action
  useEffect(() => {
    if (!isCompanionAction(initialAction)) return
    const id = window.setTimeout(
      () =>
        [heroRef, cardRef, avatarRef].forEach(r =>
          r.current?.play(initialAction)
        ),
      props.actionAt
    )
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar
  }, [])

  const initialSay = props.sayText
  useEffect(() => {
    if (!initialSay) return
    const id = window.setTimeout(() => sayAll(initialSay, false), props.sayAt)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar
  }, [])

  const common = {
    mood,
    followPointer: follow,
    interactive,
    autoplay,
    pointTo,
    framing,
    seed: props.seed,
    speakingLevel: speaking,
  }
  const show = (v: LabView) => view === 'all' || view === v
  return (
    <MetaUiScope className="min-h-dvh bg-black text-white">
      <main className="mx-auto flex max-w-[1240px] flex-col items-center gap-10 px-6 py-10">
        {showControls && (
          <header className="flex w-full flex-col gap-4">
            <p className="mu-label">
              Companion 3D · lab · {autoplay ? 'demo reel' : mood} · seed{' '}
              {props.seed}
            </p>
            <div className="flex flex-wrap gap-2">
              {COMPANION_MOODS.map(m => (
                <Toggle
                  key={m}
                  on={!autoplay && m === mood}
                  onClick={() => setMood(m)}
                >
                  {m}
                </Toggle>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {COMPANION_ACTIONS.map(a => (
                <button
                  key={a}
                  type="button"
                  onClick={() => playAll(a)}
                  className="mu-btn mu-btn-ghost"
                >
                  {a}()
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Toggle on={autoplay} onClick={() => setAutoplay(v => !v)}>
                demo reel
              </Toggle>
              <Toggle on={interactive} onClick={() => setInteractive(v => !v)}>
                interactive
              </Toggle>
              <Toggle on={follow} onClick={() => setFollow(v => !v)}>
                followPointer
              </Toggle>
              <Toggle
                on={pointTo === 'left'}
                onClick={() =>
                  setPointTo(p => (p === 'left' ? 'right' : 'left'))
                }
              >
                pointTo: {pointTo}
              </Toggle>
              <Toggle
                on={speaking !== undefined}
                onClick={() =>
                  setSpeaking(s => (s === undefined ? 0.8 : undefined))
                }
              >
                speakingLevel: {speaking ?? 'auto'}
              </Toggle>
              <Toggle
                on={framing === 'head'}
                onClick={() =>
                  setFraming(f => (f === 'head' ? 'full' : 'head'))
                }
              >
                framing: {framing}
              </Toggle>
            </div>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={e => {
                e.preventDefault()
                sayAll(text, voice)
              }}
            >
              <input
                value={text}
                onChange={e => setText(e.target.value)}
                aria-label="Texto para decir"
                className="h-[34px] min-w-[360px] flex-1 rounded-full border border-white/15 bg-transparent px-4 text-[13.5px] text-white"
              />
              <Toggle on={voice} onClick={() => setVoice(v => !v)}>
                voz: {voice ? 'on' : 'off'}
              </Toggle>
              <button type="submit" className="mu-btn mu-btn-p">
                {talking ? 'Hablando' : 'Decir'}
              </button>
            </form>
          </header>
        )}
        <section className="flex flex-wrap items-end justify-center gap-14">
          {show('hero') && (
            <Stage size={heroSize} label={`hero · ${heroSize}px`}>
              <Companion3D
                ref={heroRef}
                {...common}
                onSpeechStart={() => setTalking(true)}
                onSpeechEnd={() => setTalking(false)}
                label="Tu compañero de Meta Assistant"
              />
            </Stage>
          )}
          {show('card') && (
            <Stage size={160} label="card · 160px">
              <div className="mu-card size-full overflow-hidden rounded-[20px]">
                <Companion3D ref={cardRef} {...common} label="Tu compañero" />
              </div>
            </Stage>
          )}
          {show('avatar') && (
            <Stage size={48} label="avatar · 48px">
              <div className="size-full overflow-hidden rounded-full bg-[var(--mu-card)]">
                <Companion3D ref={avatarRef} {...common} label="Tu compañero" />
              </div>
            </Stage>
          )}
        </section>
      </main>
    </MetaUiScope>
  )
}
