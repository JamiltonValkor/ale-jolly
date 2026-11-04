'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { MetaUiScope } from '@/shared/meta-ui'

import { useLiveFace } from '../../hooks/use-live-face'
import {
  PairingTransportProvider,
  usePairingTransport,
} from '../../hooks/use-pairing-transport'
import { useRobotPairing } from '../../hooks/use-robot-pairing'
import { createDemoTransport } from '../../lib/demo-transport'
import { httpTransport } from '../../lib/http-transport'
import type { PairingTransport } from '../../lib/pairing-transport'
import { RobotScreen } from './robot-screen'

interface Props {
  locale: string
  /** `?demo=1`: transporte simulado para el escenario. */
  demo: boolean
  /** `?kiosk=1`: sin cursor. */
  kiosk: boolean
  /** `?device=`: identificador que pasa el software del robot. */
  deviceId?: string
  /** Demo: con quién se reclama solo el robot (`?name=&business=`). */
  ownerName?: string
  businessName?: string
  /** Demo: vida del código en segundos (`?ttl=`), para ensayar el vencimiento. */
  ttlSeconds?: number
  /** Demo: frase que dice al quedar en vivo (`?say=`). */
  sayText?: string
}

function buildTransport(props: Props): PairingTransport {
  if (!props.demo) return httpTransport
  const origin =
    typeof window === 'undefined'
      ? 'https://app.saleads.ai'
      : window.location.origin
  return createDemoTransport({
    qrBaseUrl: `${origin}/${props.locale}/dashboard/meta-assistant`,
    ttlMs: props.ttlSeconds ? props.ttlSeconds * 1000 : undefined,
    robotOwner: {
      firstName: props.ownerName ?? null,
      businessName: props.businessName ?? null,
    },
  })
}

const WAKE_MS = 2100

/** Demo: `?say=` al quedar en vivo y la tecla V dice una frase de muestra. */
function useDemoSpeech(
  demo: boolean,
  live: boolean,
  speak: (text: string) => void,
  sayText?: string
) {
  const t = useTranslations('companion.robot.live')
  const sample = t('sample')
  useEffect(() => {
    if (!demo || !live || !sayText) return
    const timer = setTimeout(() => speak(sayText), 1300)
    return () => clearTimeout(timer)
  }, [demo, live, sayText, speak])
  useEffect(() => {
    if (!demo || !live) return
    const onKey = (event: KeyboardEvent) =>
      event.key.toLowerCase() === 'v' && speak(sample)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demo, live, sample, speak])
}

function RobotController({
  demo,
  kiosk,
  deviceId,
  sayText,
}: Pick<Props, 'demo' | 'kiosk' | 'deviceId' | 'sayText'>) {
  const t = useTranslations('companion.robot.live')
  const transport = usePairingTransport()
  const { model, remainingMs, retryInSeconds, retryNow } = useRobotPairing({
    deviceId,
  })
  const greeting = model.ownerFirstName
    ? t('greeting', { name: model.ownerFirstName })
    : t('greetingNoName')
  const live = useLiveFace({ active: model.screen === 'live', demo, greeting })
  useDemoSpeech(demo, model.screen === 'live', live.speak, sayText)
  const [waking, setWaking] = useState(false)
  const previous = useRef(model.screen)
  const { greet } = live

  useEffect(() => {
    const woke = previous.current === 'boot' && model.screen === 'pairing'
    previous.current = model.screen
    if (!woke) return
    setWaking(true)
    const timer = setTimeout(() => setWaking(false), WAKE_MS)
    return () => clearTimeout(timer)
  }, [model.screen])

  useEffect(
    () => transport.subscribe?.(signal => signal === 'hello' && greet?.()),
    [transport, greet]
  )

  useEffect(() => {
    if (!demo || model.screen !== 'pairing') return
    // Escenario con un solo equipo: Enter o tocar la pantalla reclama el código.
    const claim = () => void transport.simulateClaim?.()
    const onKey = (event: KeyboardEvent) => event.key === 'Enter' && claim()
    window.addEventListener('keydown', onKey)
    window.addEventListener('dblclick', claim)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dblclick', claim)
    }
  }, [demo, model.screen, transport])

  return (
    <RobotScreen
      screen={model.screen}
      code={model.session?.code ?? null}
      qrUrl={model.session?.qr_url ?? null}
      remainingMs={remainingMs}
      syncStep={model.syncStep}
      ownerFirstName={model.ownerFirstName}
      businessName={model.businessName}
      retryInSeconds={retryInSeconds}
      onRetry={retryNow}
      liveFace={live.face}
      liveSay={live.say}
      amplitude={live.amplitude}
      waking={waking}
      kiosk={kiosk}
    />
  )
}

/**
 * Pantalla del robot lista para montar en una ruta pública: trae su propio
 * QueryClient (la ruta no tiene sesión ni proveedores del dashboard) y elige
 * el transporte real o el de demo.
 */
export function RobotScreenRoot(props: Props) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      })
  )
  const [transport] = useState(() => buildTransport(props))
  return (
    <QueryClientProvider client={client}>
      <PairingTransportProvider transport={transport}>
        <MetaUiScope>
          <RobotController
            demo={props.demo}
            kiosk={props.kiosk}
            deviceId={props.deviceId}
            sayText={props.sayText}
          />
        </MetaUiScope>
      </PairingTransportProvider>
    </QueryClientProvider>
  )
}
