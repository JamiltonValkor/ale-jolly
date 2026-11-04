'use client'

import { useEffect, useRef, type ElementType, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { X } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

import styles from './pairing.module.css'

interface HeaderProps {
  progress: { current: number; total: number } | null
  onClose: () => void
}

/** «Compañero físico · Paso 1 de 3» y cerrar (Esc también cierra). */
export function SheetHeader({ progress, onClose }: HeaderProps) {
  const t = useTranslations('companion.flow')
  return (
    <div className={styles.head}>
      <div className={styles.eyebrow}>
        <span className={styles.label}>{t('eyebrow')}</span>
        {progress ? (
          <span className={styles.progress}>
            <span className={styles.segments} aria-hidden="true">
              {Array.from({ length: progress.total }, (_, i) => (
                <span
                  key={i}
                  className={styles.segment}
                  data-on={i < progress.current}
                />
              ))}
            </span>
            {t('stepOf', progress)}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={onClose}
        aria-label={t('close')}
      >
        <X size={18} weight="light" aria-hidden="true" />
      </button>
    </div>
  )
}

interface StepProps {
  visual?: ReactNode
  visualCentered?: boolean
  title: string
  description?: ReactNode
  children?: ReactNode
  footer: ReactNode
  /** Dentro del Dialog: `DialogTitle` / `DialogDescription`. */
  TitleComponent?: ElementType
  DescriptionComponent?: ElementType
  focusTitle?: boolean
}

/** Cada paso: visual, título (recibe el foco), texto, contenido y pie. */
export function StepLayout({
  visual,
  visualCentered,
  title,
  description,
  children,
  footer,
  TitleComponent = 'h2',
  DescriptionComponent = 'p',
  focusTitle = true,
}: StepProps) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true })
  }, [focusTitle])
  return (
    <>
      <div className={styles.body}>
        <div className={cn(styles.step, visualCentered && styles.centered)}>
          {visual ? (
            <div
              className={cn(
                styles.visual,
                visualCentered && styles.visualCenter
              )}
            >
              {visual}
            </div>
          ) : null}
          <div className={styles.titles}>
            <TitleComponent
              ref={titleRef}
              tabIndex={-1}
              className={styles.title}
            >
              {title}
            </TitleComponent>
            {description ? (
              <DescriptionComponent className={styles.subtitle}>
                {description}
              </DescriptionComponent>
            ) : null}
          </div>
          {children}
        </div>
      </div>
      {footer ? <div className={styles.foot}>{footer}</div> : null}
    </>
  )
}

interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  primary?: boolean
  ghost?: boolean
  danger?: boolean
  busy?: boolean
  busyLabel?: string
  disabled?: boolean
  className?: string
}

/** Botón píldora del kit (`.mu-btn`); ocupado o deshabilitado sigue siendo enfocable. */
export function FlowButton({
  children,
  onClick,
  primary,
  ghost,
  danger,
  busy,
  busyLabel,
  disabled,
  className,
}: ButtonProps) {
  const inactive = busy || disabled
  return (
    <button
      type="button"
      className={cn(
        'mu-btn mu-btn-lg',
        primary && 'mu-btn-p',
        ghost && 'mu-btn-ghost',
        danger && styles.danger,
        className
      )}
      aria-disabled={inactive || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!inactive) onClick?.()
      }}
    >
      <span className={styles.btnLabel}>
        {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {busy && busyLabel ? busyLabel : children}
      </span>
    </button>
  )
}
