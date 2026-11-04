'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { CompanionPairingFlow } from '@/features/companion/components/pairing/companion-pairing-flow'
import {
  CompanionPairingView,
  type PairingViewProps,
} from '@/features/companion/components/pairing/companion-pairing-view'
import styles from '@/features/companion/components/pairing/pairing.module.css'
import { cn } from '@/lib/utils'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'

const NOW = Date.parse('2026-10-30T15:00:00Z')
const BUSINESSES = [
  { id: 'b1', name: 'Mi Negocio' },
  { id: 'b2', name: 'Café Ana' },
  { id: 'b3', name: 'Tienda Lumen' },
]
const DEVICE = {
  name: 'Compañero de Nicolás',
  paired_at: '2026-10-29T10:00:00Z',
  last_seen_at: '2026-10-30T14:59:20Z',
}

const noop = () => undefined
const BASE: PairingViewProps = {
  step: 'intro',
  code: '',
  codeFromQr: false,
  error: null,
  forbiddenTyped: false,
  businesses: BUSINESSES.slice(0, 1),
  businessId: 'b1',
  defaultBusinessId: 'b1',
  businessName: 'Mi Negocio',
  needsBusiness: false,
  syncStep: 'voice',
  syncSlow: false,
  device: null,
  claiming: false,
  unpairing: false,
  unpairFailed: false,
  tryingHello: false,
  helloNonce: 0,
  ownerFirstName: 'Nicolás',
  now: NOW,
  actions: {
    start: noop,
    changeCode: noop,
    submitCode: noop,
    chooseBusiness: noop,
    back: noop,
    retry: noop,
    tryHello: noop,
    askUnpair: noop,
    cancelUnpair: noop,
    confirmUnpair: noop,
    pairAgain: noop,
    close: noop,
  },
}

export const LAB_FLOW_CASES: Record<string, Partial<PairingViewProps>> = {
  intro: {},
  connect: { step: 'connect', code: 'K7P' },
  'connect-qr': { step: 'connect', code: 'K7P4QX', codeFromQr: true },
  'connect-error': { step: 'connect', code: 'K7P4QZ', error: 'INVALID_CODE' },
  'connect-busy': { step: 'connect', code: 'K7P4QX', claiming: true },
  business: {
    step: 'business',
    code: 'K7P4QX',
    businesses: BUSINESSES,
    needsBusiness: true,
    businessId: 'b2',
    defaultBusinessId: 'b2',
    businessName: 'Café Ana',
  },
  syncing: { step: 'syncing' },
  'syncing-slow': { step: 'syncing', syncStep: 'ready', syncSlow: true },
  success: {
    step: 'success',
    device: { ...DEVICE, paired_at: '2026-10-30T14:59:50Z' },
  },
  'success-hello': {
    step: 'success',
    device: DEVICE,
    tryingHello: true,
    helloNonce: 1,
  },
  'error-offline': { step: 'error', error: 'DEVICE_OFFLINE' },
  'error-taken': { step: 'error', error: 'ALREADY_PAIRED' },
  'error-network': { step: 'error', error: 'NETWORK' },
  device: { step: 'device', device: DEVICE },
  'confirm-unpair': { step: 'confirm-unpair', device: DEVICE },
  unpaired: { step: 'unpaired' },
}

export function FlowFrame({ name }: { name: string }) {
  const overrides = LAB_FLOW_CASES[name] ?? {}
  return (
    <div
      data-meta-ui=""
      className={cn(META_UI_FONT_CLASS, styles.sheet, styles.frame)}
    >
      <CompanionPairingView {...BASE} {...overrides} />
    </div>
  )
}

export function LabFlowSection({ only }: { only?: string }) {
  const t = useTranslations('companion.lab')
  const names =
    only && LAB_FLOW_CASES[only] ? [only] : Object.keys(LAB_FLOW_CASES)
  return (
    <section className="grid gap-4">
      <h2 className="mu-label">{t('flow')}</h2>
      <div className="flex flex-wrap items-start gap-8">
        {names.map(name => (
          <figure key={name} className="grid gap-2">
            <FlowFrame name={name} />
            <figcaption className="mu-mono text-xs text-white/40">
              {name}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

/** El flujo real en modo demo: se coordina con `/companion?demo=1` en otra pestaña. */
export function LabDemoSection({
  locale,
  autoOpen,
  pair,
}: {
  locale: string
  autoOpen: boolean
  pair?: string
}) {
  const t = useTranslations('companion.lab')
  const [open, setOpen] = useState(autoOpen)
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  return (
    <section className="grid gap-4">
      <h2 className="mu-label">{t('demo')}</h2>
      <p className="max-w-[60ch] text-[15px] text-white/60">{t('demoBody')}</p>
      <div className="flex gap-3">
        <a
          className="mu-btn"
          href={`/${locale}/companion?demo=1`}
          target="_blank"
          rel="noreferrer"
        >
          {t('openRobot')}
        </a>
        <button
          type="button"
          className="mu-btn mu-btn-p"
          onClick={() => setOpen(true)}
        >
          {t('openFlow')}
        </button>
      </div>
      <QueryClientProvider client={client}>
        <CompanionPairingFlow
          open={open}
          onOpenChange={setOpen}
          initialCode={pair}
          businesses={BUSINESSES.slice(0, 2)}
          selectedBusinessId="b1"
          ownerFirstName="Nicolás"
          mode="demo"
        />
      </QueryClientProvider>
    </section>
  )
}
