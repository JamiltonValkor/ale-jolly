'use client'

import { useTranslations } from 'next-intl'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

import type { FaceState } from '../../lib/face-state'
import type { SayLine } from '../face/companion-face'
import type { RobotScreenState } from '../../lib/robot-screen-machine'
import type { SyncStep } from '../../types/pairing.schemas'
import { RobotPairingPanel } from './robot-pairing-panel'
import {
  RobotBootPanel,
  RobotLivePanel,
  RobotOfflinePanel,
  RobotPairedPanel,
  RobotSyncPanel,
} from './robot-status-panels'
import styles from './robot-screen.module.css'

export interface RobotScreenProps {
  screen: RobotScreenState
  code?: string | null
  qrUrl?: string | null
  remainingMs?: number | null
  syncStep?: SyncStep | null
  ownerFirstName?: string | null
  businessName?: string | null
  retryInSeconds?: number | null
  onRetry?: () => void
  liveFace?: FaceState
  /** En vivo: frase que dice con sincronía labial. */
  liveSay?: SayLine
  amplitude?: number
  plateColor?: string
  /** `?kiosk=1`: sin cursor. */
  kiosk?: boolean
  /** Justo después de encender: la cara se despierta al mostrar el código. */
  waking?: boolean
  /** Dentro de un marco (laboratorio) en vez de pantalla completa. */
  contained?: boolean
  className?: string
}

const EASE = [0.22, 1, 0.36, 1] as const

function Panel(props: RobotScreenProps) {
  const { screen, plateColor } = props
  switch (screen) {
    case 'boot':
      return <RobotBootPanel />
    case 'pairing':
    case 'expired':
      return (
        <RobotPairingPanel
          phase={screen === 'expired' ? 'renewing' : 'waiting'}
          code={props.code ?? null}
          qrUrl={props.qrUrl ?? null}
          remainingMs={props.remainingMs ?? null}
          waking={props.waking}
          plateColor={plateColor}
        />
      )
    case 'syncing':
      return (
        <RobotSyncPanel
          step={props.syncStep ?? null}
          businessName={props.businessName ?? null}
          plateColor={plateColor}
        />
      )
    case 'paired':
      return (
        <RobotPairedPanel
          ownerFirstName={props.ownerFirstName ?? null}
          businessName={props.businessName ?? null}
          plateColor={plateColor}
        />
      )
    case 'live':
      return (
        <RobotLivePanel
          face={props.liveFace ?? 'idle'}
          say={props.liveSay}
          amplitude={props.amplitude}
          plateColor={plateColor}
        />
      )
    case 'offline':
      return (
        <RobotOfflinePanel
          retryInSeconds={props.retryInSeconds ?? null}
          onRetry={props.onRetry}
          plateColor={plateColor}
        />
      )
  }
}

/**
 * Lo que muestra la pantallita del robot. Presentacional: el estado llega
 * por props (contenedor: `RobotScreenRoot`; laboratorio: fixtures).
 */
export function RobotScreen(props: RobotScreenProps) {
  const t = useTranslations('companion.robot')
  const reduced = useReducedMotion() ?? false
  const key = props.screen === 'expired' ? 'pairing' : props.screen
  const enter =
    reduced || key === 'live'
      ? false
      : { opacity: 0, y: 28, scale: 0.975, filter: 'blur(10px)' }
  return (
    <main
      aria-label={t('screenLabel')}
      className={cn(
        styles.screen,
        props.kiosk && styles.kiosk,
        props.contained && styles.contained,
        props.className
      )}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={key}
          className="absolute inset-0"
          initial={enter}
          animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
          exit={
            reduced
              ? { opacity: 0 }
              : { opacity: 0, scale: 1.02, filter: 'blur(8px)' }
          }
          transition={{ duration: 0.7, ease: EASE }}
        >
          <Panel {...props} />
        </motion.div>
      </AnimatePresence>
    </main>
  )
}
