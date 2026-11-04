'use client'

import type { ReactNode } from 'react'
import type { Route } from 'next'
import Link from 'next/link'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { Coins, Megaphone, type Icon } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { SaInput } from '@/shared/components/sa-input'
import { cn } from '@/lib/utils'

export type CompactCardState = 'loading' | 'error' | 'unavailable' | 'ready'

export interface CompactFormProps {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  error?: string
  pending: boolean
  onSubmit: () => void
  inputMode: 'decimal' | 'numeric'
}

/** Un campo y «Guardar» en la misma línea. */
function CompactForm(props: CompactFormProps) {
  const t = useTranslations('autonomousTeam.limits.compact')
  return (
    <form
      className="flex items-start gap-2"
      onSubmit={event => {
        event.preventDefault()
        props.onSubmit()
      }}
    >
      <div className="min-w-0 flex-1">
        <SaInput
          aria-label={props.label}
          inputMode={props.inputMode}
          placeholder={props.placeholder}
          value={props.value}
          error={props.error}
          onChange={event => props.onChange(event.target.value)}
        />
      </div>
      <SaButton
        type="submit"
        variant="accent"
        isLoading={props.pending}
        disabled={props.pending}
      >
        {t('save')}
      </SaButton>
    </form>
  )
}

interface CardProps {
  icon: Icon
  title: string
  /** El mes o la fecha que importa, en una cápsula. */
  chip?: string
  state: CompactCardState
  children?: ReactNode
}

/** Tarjeta de un límite: ícono, nombre y sus estados de lectura. */
function CompactCard({
  icon: CardIcon,
  title,
  chip,
  state,
  children,
}: CardProps) {
  const t = useTranslations('autonomousTeam.limits')
  return (
    <section className="bg-sa-surface-card border-sa-border-default flex flex-col gap-5 rounded-3xl border p-5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="bg-sa-surface-card-hover text-sa-text-primary grid size-9 shrink-0 place-items-center rounded-xl"
        >
          <CardIcon size={18} weight="light" />
        </span>
        <h3 className="text-sa-text-primary flex-1 text-[15px] font-medium">
          {title}
        </h3>
        {chip ? (
          <span className="bg-sa-surface-card-hover text-sa-text-secondary rounded-full px-2.5 py-1 text-xs first-letter:uppercase">
            {chip}
          </span>
        ) : null}
      </div>
      {state === 'loading' ? (
        <div
          role="status"
          aria-label={title}
          className="bg-sa-surface-card-hover h-24 animate-pulse rounded-2xl"
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
    </section>
  )
}

interface FigureProps {
  value: string
  /** Sin fijar: la cifra se apaga. */
  muted: boolean
  note: string
  warn?: boolean
  children?: ReactNode
}

/** La cifra grande y una sola línea que dice qué significa. */
function Figure({ value, muted, note, warn = false, children }: FigureProps) {
  return (
    <div className="flex flex-col gap-2">
      <p
        className={cn(
          'text-[30px] leading-none font-semibold tracking-[-0.02em] tabular-nums',
          muted ? 'text-sa-text-tertiary' : 'text-sa-text-primary'
        )}
      >
        {value}
      </p>
      {children}
      <p
        className={cn(
          'text-[13.5px] leading-snug',
          warn ? 'text-sa-state-warning' : 'text-sa-text-secondary'
        )}
      >
        {note}
      </p>
    </div>
  )
}

interface BudgetViewProps {
  state: CompactCardState
  /** Ya con moneda («COP 1.500.000»); `null` = sin fijar. */
  amount: string | null
  month: string
  /** Sin cuenta de Meta no hay moneda: el camino para conectarla. */
  connect?: boolean
  form?: CompactFormProps
  notice?: ReactNode
}

/** «Pauta al mes»: cuánto reparte sin preguntarte. */
export function BudgetCardView(props: BudgetViewProps) {
  const t = useTranslations('autonomousTeam.limits.compact.budget')
  const locale = useLocale()
  return (
    <CompactCard
      icon={Megaphone}
      title={t('title')}
      chip={props.month}
      state={props.state}
    >
      <Figure
        value={props.amount ?? t('unset')}
        muted={props.amount === null}
        note={
          props.connect
            ? t('connect')
            : props.amount
              ? t('setNote')
              : t('unsetNote')
        }
      />
      {props.connect ? (
        <Link
          href={`/${locale}/dashboard/connected-accounts` as Route}
          className="border-sa-border-default text-sa-text-primary hover:border-sa-border-hover inline-flex h-9 items-center self-start rounded-full border px-4 text-sm font-medium transition-colors"
        >
          {t('connectCta')}
        </Link>
      ) : props.form ? (
        <CompactForm {...props.form} />
      ) : null}
      {props.notice}
    </CompactCard>
  )
}

interface CreditsViewProps {
  state: CompactCardState
  /** `null` = sin tope (no genera piezas); `0` = no usa créditos. */
  cap: number | null
  used: number
  /** Fecha corta del reinicio («1 nov»). */
  resets: string
  form?: CompactFormProps
  notice?: ReactNode
}

/** «Créditos al mes»: el tope y cuánto va, en una barra. */
export function CreditsCardView(props: CreditsViewProps) {
  const t = useTranslations('autonomousTeam.limits.compact.credits')
  const format = useFormatter()
  const { cap, used } = props
  const note =
    cap === null
      ? t('unsetNote')
      : cap === 0
        ? t('zeroNote')
        : t('used', { used: format.number(used), date: props.resets })
  return (
    <CompactCard icon={Coins} title={t('title')} state={props.state}>
      <Figure
        value={cap === null ? t('unset') : format.number(cap)}
        muted={cap === null}
        note={note}
        warn={cap === null}
      >
        {cap ? (
          <progress
            aria-label={t('meter')}
            value={Math.min(used, cap)}
            max={cap}
            className="[&::-moz-progress-bar]:bg-sa-text-primary [&::-webkit-progress-bar]:bg-sa-surface-card-hover [&::-webkit-progress-value]:bg-sa-text-primary bg-sa-surface-card-hover mt-1 h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full"
          />
        ) : null}
      </Figure>
      {props.form ? <CompactForm {...props.form} /> : null}
      {props.notice}
    </CompactCard>
  )
}
