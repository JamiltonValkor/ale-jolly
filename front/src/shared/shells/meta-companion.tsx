'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  Companion3D,
  CompanionFace,
  CompanionPairingFlow,
  resolveTransportMode,
  useCompanionLink,
  type Companion3DAction,
  type Companion3DMood,
  type CompanionHandle,
  type PairingCompanionRenderInput,
} from '@/features/companion'
import type {
  CompanionLink,
  CompanionMood,
  CompanionRenderInput,
  FaceRenderInput,
  PairingRenderInput,
} from '@/features/sales-assistant'
import { useBusinessStore } from '@/store/use-business-store'

interface MoodPlan {
  mood: Companion3DMood
  /** Gesto al entrar en el ánimo (lo que en el personaje es una acción). */
  enter?: Companion3DAction
}

/** La coreografía de Meta Assistant en el repertorio del personaje 3D. */
export const MOOD_PLAN: Record<CompanionMood, MoodPlan> = {
  idle: { mood: 'idle' },
  listening: { mood: 'listening' },
  thinking: { mood: 'thinking' },
  speaking: { mood: 'speaking' },
  happy: { mood: 'happy' },
  celebrating: { mood: 'celebrating' },
  sleeping: { mood: 'sleeping' },
  waking: { mood: 'listening', enter: 'wake' },
  syncing: { mood: 'syncing' },
  working: { mood: 'working' },
  dancing: { mood: 'dancing' },
  surprised: { mood: 'idle', enter: 'surprised' },
  shy: { mood: 'shy' },
  confused: { mood: 'confused' },
  worried: { mood: 'worried' },
}

type FaceState =
  | 'sleeping'
  | 'waking'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'happy'
  | 'syncing'
  | 'error'

const FACE_STATE: Record<CompanionMood, FaceState> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  happy: 'happy',
  celebrating: 'happy',
  sleeping: 'sleeping',
  waking: 'waking',
  syncing: 'syncing',
  working: 'thinking',
  dancing: 'happy',
  surprised: 'idle',
  shy: 'happy',
  confused: 'error',
  worried: 'error',
}

/**
 * Puente entre Meta Assistant (sales-assistant) y el compañero (companion):
 * traduce ánimos, gestos y lo que dice. Vive en la capa de composición
 * porque junta dos features. En el chat (`mini`) se asoma solo la cabeza.
 */
export function MetaCompanion({
  mood,
  size,
  label,
  action,
  interactive,
  say,
  voice,
}: CompanionRenderInput) {
  const ref = useRef<CompanionHandle>(null)
  const plan = MOOD_PLAN[mood]
  const enteredMood = useRef<CompanionMood | null>(null)
  useEffect(() => {
    if (enteredMood.current === mood) return
    enteredMood.current = mood
    if (plan.enter) ref.current?.play(plan.enter)
  }, [mood, plan.enter])
  const nonce = action?.nonce
  const actionName = action?.name
  useEffect(() => {
    if (nonce === undefined || !actionName) return
    ref.current?.play(actionName)
  }, [nonce, actionName])
  return (
    <Companion3D
      ref={ref}
      mood={plan.mood}
      label={label}
      framing={size === 'mini' ? 'head' : 'full'}
      say={
        say
          ? {
              text: say.text,
              nonce: say.nonce,
              voice: Boolean(voice),
              lang: 'es-CO',
            }
          : undefined
      }
      interactive={interactive}
      followPointer={interactive}
      className="size-full"
    />
  )
}

/** Para pasar directo como `renderCompanion`. */
export function renderMetaCompanion(input: CompanionRenderInput) {
  return <MetaCompanion {...input} />
}

/**
 * Tu asistente asomado en el menú lateral: su cara con capucha, viva
 * (parpadea). Con el puntero encima (`engaged`) te mira atento.
 */
export function MetaSidebarAvatar({ engaged = false }: { engaged?: boolean }) {
  return (
    <CompanionFace
      state={engaged ? 'listening' : 'idle'}
      variant="head"
      decorative
      className="block size-full"
    />
  )
}

/** Avatares pequeños del chat: la cara dentro de su capucha (variante `head`). */
export function renderMetaFace({ mood, label }: FaceRenderInput) {
  return (
    <CompanionFace
      state={FACE_STATE[mood]}
      variant="head"
      label={label}
      className="block size-full"
    />
  )
}

/** La cabeza 3D estilo Muse dentro del flujo de sincronización, hablando. */
function renderPairingHead({ mood, say, voice }: PairingCompanionRenderInput) {
  return (
    <Companion3D
      mood={mood}
      framing="head"
      label="Tu compañero"
      say={
        say
          ? { text: say.text, nonce: say.nonce, voice, lang: 'es-CO' }
          : undefined
      }
      interactive
      className="size-full"
    />
  )
}

function MetaPairing({ open, onOpenChange, initialCode }: PairingRenderInput) {
  const { data: session } = useSession()
  const business = useBusinessStore(state => state.selectedBusiness)
  const params = useSearchParams()
  const businesses = business
    ? [{ id: business.business_id, name: business.business_name }]
    : []
  return (
    <CompanionPairingFlow
      open={open}
      onOpenChange={onOpenChange}
      initialCode={initialCode ?? undefined}
      businesses={businesses}
      selectedBusinessId={business?.business_id}
      ownerFirstName={session?.user?.name?.trim().split(/\s+/)[0]}
      renderCompanion={renderPairingHead}
      mode={resolveTransportMode(params.get('demo'))}
    />
  )
}

/** Sincronizar el compañero físico (`?demo=1` usa el transporte de escenario). */
export function renderMetaPairing(input: PairingRenderInput) {
  return <MetaPairing {...input} />
}

/** Estado real del compañero físico para «Hoy» (`?demo=1` lee el de escenario). */
export function useMetaCompanionLink(): CompanionLink | null {
  const params = useSearchParams()
  return useCompanionLink(resolveTransportMode(params.get('demo')))
}
