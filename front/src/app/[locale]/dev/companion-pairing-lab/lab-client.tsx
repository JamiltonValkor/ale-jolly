'use client'

import { useTranslations } from 'next-intl'

import { isFaceState } from '@/features/companion/lib/face-state'
import type { RobotScreenState } from '@/features/companion/lib/robot-screen-machine'
import { MetaUiScope } from '@/shared/meta-ui'

import { LAB_ROBOT_STATES, isLabFrame, type LabFrame } from './lab-fixtures'
import { FlowFrame, LabDemoSection, LabFlowSection } from './lab-flow'
import {
  LabFaceSection,
  LabLiveVoice,
  LabRobotSection,
  RobotFrame,
} from './lab-robot'

interface Props {
  locale: string
  section?: string
  state?: string
  frame?: string
  solo: boolean
  open: boolean
  pair?: string
  /** `?speak=1`: la frase arranca sola (capturas a mitad de frase). */
  speak: boolean
}

function asRobotState(value: string | undefined): RobotScreenState | undefined {
  return LAB_ROBOT_STATES.find(state => state === value)
}

export function CompanionLab({
  locale,
  section,
  state,
  frame,
  solo,
  open,
  pair,
  speak,
}: Props) {
  const t = useTranslations('companion.lab')
  const tLive = useTranslations('companion.robot.live')
  const labFrame: LabFrame = isLabFrame(frame) ? frame : '800x480'
  const robotState = asRobotState(state)

  if (solo && section === 'robot' && robotState) {
    return (
      <MetaUiScope className="min-h-screen">
        <RobotFrame
          state={robotState}
          frame={labFrame}
          say={
            speak && robotState === 'live'
              ? { text: tLive('sample'), nonce: 1 }
              : undefined
          }
        />
      </MetaUiScope>
    )
  }

  if (solo && section === 'flow' && state) {
    // El paso como se ve abierto: velo del modal y la hoja centrada (abajo en móvil).
    return (
      <MetaUiScope className="grid min-h-screen place-items-center bg-[rgba(6,6,8,0.62)] max-[599px]:items-end">
        <FlowFrame name={state} />
      </MetaUiScope>
    )
  }

  const show = (name: string) => !section || section === name
  return (
    <MetaUiScope className="min-h-screen">
      <main className="mx-auto grid max-w-[1680px] gap-14 px-8 py-10">
        <header className="grid gap-2">
          <h1 className="text-[34px] font-semibold tracking-[-0.035em]">
            {t('title')}
          </h1>
          <p className="text-[15px] text-white/50">{t('subtitle')}</p>
        </header>
        {show('faces') ? (
          <LabFaceSection
            only={isFaceState(state) ? state : undefined}
            speak={speak}
          />
        ) : null}
        {show('robot') ? (
          <LabRobotSection frame={labFrame} only={robotState} />
        ) : null}
        {show('robot') || show('voice') ? (
          <LabLiveVoice frame={labFrame} autoSpeak={speak} />
        ) : null}
        {show('flow') ? <LabFlowSection only={state} /> : null}
        {show('demo') ? (
          <LabDemoSection locale={locale} autoOpen={open} pair={pair} />
        ) : null}
      </main>
    </MetaUiScope>
  )
}
