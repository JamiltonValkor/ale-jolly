'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { CompanionFace } from '@/features/companion/components/face/companion-face'
import { RobotScreen } from '@/features/companion/components/robot-screen/robot-screen'
import {
  FACE_STATES,
  type FaceState,
} from '@/features/companion/lib/face-state'
import type { RobotScreenState } from '@/features/companion/lib/robot-screen-machine'

import {
  LAB_BUSINESS,
  LAB_CODE,
  LAB_FACE_SIZES,
  LAB_FRAMES,
  LAB_LIVE_FACE,
  LAB_OWNER,
  LAB_QR,
  LAB_ROBOT_STATES,
  type LabFrame,
} from './lab-fixtures'

export function RobotFrame({
  state,
  frame,
  say,
}: {
  state: RobotScreenState
  frame: LabFrame
  say?: { text: string; nonce: number }
}) {
  const size = LAB_FRAMES[frame]
  return (
    <div
      className="relative shrink-0 overflow-hidden"
      style={{ width: size.width, height: size.height }}
      data-lab-frame={`${state}-${frame}`}
    >
      <RobotScreen
        contained
        screen={state}
        code={LAB_CODE}
        qrUrl={LAB_QR}
        remainingMs={8 * 60_000 + 20_000}
        syncStep="voice"
        ownerFirstName={LAB_OWNER}
        businessName={LAB_BUSINESS}
        retryInSeconds={8}
        onRetry={() => undefined}
        liveFace={say ? 'speaking' : LAB_LIVE_FACE}
        liveSay={say}
      />
    </div>
  )
}

export function LabRobotSection({
  frame,
  only,
}: {
  frame: LabFrame
  only?: RobotScreenState
}) {
  const t = useTranslations('companion.lab')
  const states = only ? [only] : LAB_ROBOT_STATES
  return (
    <section className="grid gap-4">
      <h2 className="mu-label">
        {t('robot')} · {frame}
      </h2>
      <div className="flex flex-wrap gap-6">
        {states.map(state => (
          <figure key={state} className="grid gap-2">
            <div className="overflow-hidden rounded-[18px] ring-1 ring-white/10">
              <RobotFrame state={state} frame={frame} />
            </div>
            <figcaption className="mu-mono text-xs text-white/40">
              {state}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

export function LabFaceSection({
  only,
  speak = false,
}: {
  only?: FaceState
  speak?: boolean
}) {
  const t = useTranslations('companion.lab')
  const tSuccess = useTranslations('companion.flow.success')
  const greeting = speak
    ? {
        text: tSuccess('companionSays', {
          name: LAB_OWNER,
          business: LAB_BUSINESS,
        }),
        nonce: 1,
      }
    : undefined
  const states = only ? [only] : FACE_STATES
  return (
    <section className="grid gap-4">
      <h2 className="mu-label">{t('faces')}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5">
        {states.map(state => (
          <figure key={state} className="grid gap-2">
            <CompanionFace state={state} />
            <figcaption className="mu-mono text-xs text-white/40">
              {state}
            </figcaption>
          </figure>
        ))}
      </div>
      <h2 className="mu-label mt-4">{t('sizes')}</h2>
      <div className="flex items-end gap-6">
        {LAB_FACE_SIZES.map(size => (
          <div key={size} style={{ width: size }}>
            <CompanionFace state="idle" />
          </div>
        ))}
        <div className="h-[160px] w-[240px] overflow-hidden rounded-[18px]">
          <CompanionFace state="happy" fit="bleed" />
        </div>
      </div>
      <h2 className="mu-label mt-4">head</h2>
      <div className="flex items-end gap-6">
        {[26, 32, 64].map(size => (
          <div key={size} style={{ width: size }}>
            <CompanionFace variant="head" state="idle" />
          </div>
        ))}
        <div className="w-[150px]">
          <CompanionFace variant="head" state="happy" say={greeting} />
        </div>
        <div className="w-[150px]">
          <CompanionFace variant="head" state="error" />
        </div>
      </div>
    </section>
  )
}

/** «Probar voz»: la cara del robot en vivo dice una frase con sincronía labial. */
export function LabLiveVoice({
  frame,
  autoSpeak,
}: {
  frame: LabFrame
  autoSpeak: boolean
}) {
  const t = useTranslations('companion')
  const [nonce, setNonce] = useState(autoSpeak ? 1 : 0)
  const say = nonce > 0 ? { text: t('robot.live.sample'), nonce } : undefined
  return (
    <section className="grid gap-4">
      <div className="flex items-center gap-3">
        <h2 className="mu-label">live · {frame}</h2>
        <button
          type="button"
          className="mu-btn"
          onClick={() => setNonce(n => n + 1)}
        >
          {t('lab.tryVoice')}
        </button>
      </div>
      <div className="overflow-hidden rounded-[18px] ring-1 ring-white/10">
        <RobotFrame state="live" frame={frame} say={say} />
      </div>
    </section>
  )
}
