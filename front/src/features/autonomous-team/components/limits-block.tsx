'use client'

// TDD-SKIP: contenedor presentacional; cubierto por agent-limits-panel.test.tsx
import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { SaCard } from '@/shared/components/sa-card'

interface Props {
  title: string
  help: string
  /** Estado de la lectura: el bloque se pinta igual que el resto aunque falte el back. */
  state: 'loading' | 'error' | 'unavailable' | 'ready'
  children?: ReactNode
}

/** Bloque de «Límites» con sus estados de carga, `available:false` y error (AAF-004). */
export function LimitsBlock({ title, help, state, children }: Props) {
  const t = useTranslations('autonomousTeam.limits')
  return (
    <SaCard variant="filled" className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-sa-text-primary text-base font-semibold">
          {title}
        </h2>
        <p className="text-sa-text-secondary text-sm">{help}</p>
      </div>
      {state === 'loading' ? (
        <div
          role="status"
          aria-label={title}
          className="bg-sa-surface-elevated h-16 animate-pulse rounded-lg"
        />
      ) : state === 'error' ? (
        <p role="alert" className="text-sa-text-secondary text-sm">
          {t('error')}
        </p>
      ) : state === 'unavailable' ? (
        <p className="text-sa-text-secondary text-sm">{t('comingSoon')}</p>
      ) : (
        children
      )}
    </SaCard>
  )
}

export function Notice({
  kind,
  text,
}: {
  kind: 'success' | 'warning' | 'error'
  text: string
}) {
  const tone =
    kind === 'success'
      ? 'text-sa-state-success'
      : kind === 'warning'
        ? 'text-sa-state-warning'
        : 'text-sa-state-error'
  return (
    <p
      role={kind === 'success' ? 'status' : 'alert'}
      className={`${tone} text-sm`}
    >
      {text}
    </p>
  )
}
