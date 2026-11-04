'use client'

import * as React from 'react'
import { cva } from 'class-variance-authority'
import { SpinnerGap } from '@phosphor-icons/react'
import { Slot } from 'radix-ui'
import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import { GradientSpinner } from './gradient-spinner'
import { useSpinnerTimer } from './use-spinner-timer'

const saButtonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4 shrink-0 [&_svg]:shrink-0 focus-visible:ring-2 focus-visible:ring-sa-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-sa-surface-base',
  {
    variants: {
      variant: {
        secondary:
          'bg-sa-surface-elevated border border-sa-border-subtle text-white rounded-full hover:bg-sa-surface-elevated-active active:bg-white active:text-sa-surface-base active:scale-[0.98]',
        accent:
          'bg-sa-interactive-accent hover:bg-sa-interactive-accent/90 text-white rounded-full',
        ghost:
          'bg-transparent hover:bg-sa-surface-elevated text-sa-text-secondary rounded-full',
        'wizard-ghost':
          'bg-white/[0.04] hover:bg-white/[0.08] text-white rounded-full',
        outline:
          'bg-transparent border border-sa-border-default hover:border-sa-border-hover text-sa-text-primary rounded-full',
        destructive:
          'bg-sa-state-error hover:bg-sa-state-error/90 text-white rounded-full',
        spinner:
          'bg-white text-sa-surface-base rounded-full border border-sa-border-subtle disabled:opacity-100',
        link: 'bg-transparent text-sa-text-link hover:underline underline-offset-4 p-0 h-auto',
      },
      size: {
        sm: 'h-8 px-3 text-xs has-[>svg]:px-2.5',
        md: 'h-9 px-4 py-2 has-[>svg]:px-3',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  }
)

type SaButtonVariant =
  | 'primary'
  | 'primary-spinner'
  | 'secondary'
  | 'accent'
  | 'ghost'
  | 'wizard-ghost'
  | 'outline'
  | 'destructive'
  | 'spinner'
  | 'link'

type SaButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const primarySizeClasses: Record<SaButtonSize, string> = {
  sm: 'px-3 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-sm',
  icon: 'p-2',
}

function SpinningGradientBorder() {
  return (
    <span
      className="sa-moving-border-gradient pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
      aria-hidden="true"
      style={{
        width: 800,
        height: 800,
        maxWidth: 'none',
        background:
          'conic-gradient(from 0deg, rgb(228,212,255), rgb(100,41,205), rgb(12,0,18), rgb(255,102,0), rgb(255,219,195), rgb(228,212,255))',
      }}
    />
  )
}

export interface SaButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick'
> {
  variant?: SaButtonVariant
  size?: SaButtonSize
  asChild?: boolean
  /** Controlled loading state */
  isLoading?: boolean
  /** When true + isLoading, replaces content with a gradient spinner */
  gradientSpinner?: boolean
  /** Called when the spinner variant completes its animation */
  onSpinnerComplete?: () => void
  /** Alternative content shown during spinner animation (primary-spinner variant) */
  spinnerContent?: React.ReactNode
  /** Custom spinner duration in ms (defaults: primary-spinner=2000, spinner=1500) */
  spinnerDuration?: number
  /** Position of the spinner icon relative to spinnerContent (default: 'left') */
  spinnerPosition?: 'left' | 'right'
  leftIcon?: React.ComponentType<{ className?: string }>
  rightIcon?: React.ComponentType<{ className?: string }>
  containerClassName?: string
  onClick?: () => void
}

function SaButton({
  className,
  containerClassName,
  variant = 'secondary',
  size = 'md',
  asChild = false,
  isLoading = false,
  gradientSpinner = false,
  onSpinnerComplete,
  spinnerContent,
  spinnerDuration,
  spinnerPosition = 'left',
  leftIcon: LeftIcon,
  rightIcon: RightIcon,
  children,
  disabled,
  onClick,
  ...props
}: SaButtonProps) {
  const tA11y = useTranslations('common.accessibility')
  const showGradient = isLoading && gradientSpinner

  const { isSpinnerActive, handleSpinnerClick } = useSpinnerTimer({
    onClick,
    onSpinnerComplete,
    isLoading,
    variant: variant ?? 'secondary',
    spinnerDuration,
  })

  const showSpinner = variant === 'spinner' && (isSpinnerActive || isLoading)

  // Primary variant: CSS animated conic-gradient spinning border
  if (variant === 'primary') {
    return (
      <button
        type="button"
        data-slot="sa-button"
        {...props}
        onClick={onClick}
        disabled={disabled || isLoading}
        aria-busy={isLoading || undefined}
        className={cn(
          'sa-moving-border-container group relative inline-flex cursor-pointer overflow-hidden rounded-full p-px',
          'transition-shadow duration-300 motion-reduce:transition-none',
          'hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(100,41,205,0.4),0_0_60px_rgba(255,102,0,0.15)]',
          'active:scale-[0.98] motion-reduce:hover:scale-100 motion-reduce:active:scale-100',
          'focus-visible:ring-sa-border-focus focus-visible:ring-offset-sa-surface-base focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
          containerClassName
        )}
      >
        <SpinningGradientBorder />
        <span
          className={cn(
            'relative z-10 inline-flex w-full items-center justify-center gap-2 rounded-full',
            'bg-[rgba(12,0,18,0.92)] font-medium text-white antialiased',
            'transition-colors duration-300 motion-reduce:transition-none',
            'group-hover:bg-[rgba(12,0,18,0.85)]',
            primarySizeClasses[size],
            className
          )}
        >
          {showGradient ? (
            <GradientSpinner />
          ) : (
            <>
              {LeftIcon && <LeftIcon className="size-4" />}
              {children}
              {RightIcon && <RightIcon className="size-4" />}
            </>
          )}
        </span>
      </button>
    )
  }

  // Primary-spinner: CSS animated border with spinner delay before executing onClick
  if (variant === 'primary-spinner') {
    const showPrimarySpinner = isSpinnerActive || isLoading
    const iconOnly = showPrimarySpinner && !spinnerContent
    return (
      <button
        type="button"
        data-slot="sa-button"
        {...props}
        onClick={showPrimarySpinner ? undefined : handleSpinnerClick}
        disabled={disabled}
        aria-busy={showPrimarySpinner || undefined}
        className={cn(
          'sa-moving-border-container group relative inline-flex cursor-pointer overflow-hidden rounded-full p-px',
          'transition-all duration-300 motion-reduce:transition-none',
          !showPrimarySpinner &&
            'hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(100,41,205,0.4),0_0_60px_rgba(255,102,0,0.15)]',
          'active:scale-[0.98] motion-reduce:hover:scale-100 motion-reduce:active:scale-100',
          'focus-visible:ring-sa-border-focus focus-visible:ring-offset-sa-surface-base focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
          'duration-500 ease-in-out [interpolate-size:allow-keywords]',
          iconOnly && '!w-11 !min-w-0',
          containerClassName
        )}
      >
        <SpinningGradientBorder />
        <span
          className={cn(
            'relative z-10 inline-flex w-full items-center justify-center gap-2 rounded-full',
            'bg-[rgba(12,0,18,0.92)] font-medium text-white antialiased',
            'transition-colors duration-300 motion-reduce:transition-none',
            'group-hover:bg-[rgba(12,0,18,0.85)]',
            primarySizeClasses[size],
            className
          )}
        >
          {showPrimarySpinner ? (
            <span
              className={cn(
                'inline-flex items-center gap-2 whitespace-nowrap',
                spinnerPosition === 'right' && 'flex-row-reverse'
              )}
            >
              <SpinnerGap
                size={iconOnly ? 26 : 18}
                weight="bold"
                className="shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {spinnerContent}
            </span>
          ) : (
            <>
              {LeftIcon && <LeftIcon className="size-4" />}
              {children}
              {RightIcon && <RightIcon className="size-4" />}
            </>
          )}
        </span>
      </button>
    )
  }

  // Spinner variant: same-size button with spinning indicator (no layout shift)
  if (showSpinner) {
    return (
      <button
        type="button"
        data-slot="sa-button"
        {...props}
        aria-label={tA11y('loading')}
        className={cn(
          saButtonVariants({ variant: 'spinner', size, className })
        )}
        disabled
        aria-busy={true}
      >
        <SpinnerGap
          size={18}
          weight="bold"
          className="animate-spin"
          aria-hidden="true"
        />
      </button>
    )
  }

  // All other variants use the standard button
  const Comp = asChild ? Slot.Root : 'button'
  // Spinner idle state inherits secondary appearance
  const displayVariant = variant === 'spinner' ? 'secondary' : variant

  return (
    <Comp
      data-slot="sa-button"
      {...props}
      className={cn(
        saButtonVariants({ variant: displayVariant, size, className })
      )}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      onClick={variant === 'spinner' ? handleSpinnerClick : onClick}
    >
      {showGradient ? (
        <GradientSpinner />
      ) : (
        <>
          {LeftIcon && <LeftIcon className="size-4" />}
          {children}
          {RightIcon && <RightIcon className="size-4" />}
        </>
      )}
    </Comp>
  )
}

export { SaButton, saButtonVariants }
