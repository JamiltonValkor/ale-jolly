import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const saBadgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border font-mono font-medium uppercase w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1.5 [&>svg]:pointer-events-none transition-colors',
  {
    variants: {
      variant: {
        default:
          'bg-sa-interactive-primary/15 text-sa-purple-400 border-sa-interactive-primary/20',
        recommended:
          'bg-[var(--sa-badge-recommended-bg)] text-[var(--sa-badge-recommended-text)] border-[var(--sa-badge-recommended-border)]',
        success:
          'bg-[var(--sa-badge-success-bg)] text-[var(--sa-badge-success-text)] border-[var(--sa-badge-success-border)]',
        warning:
          'bg-[var(--sa-badge-warning-bg)] text-[var(--sa-badge-warning-text)] border-[var(--sa-badge-warning-border)]',
        error:
          'bg-sa-state-error-bg text-sa-state-error border-sa-state-error-border',
        info: 'bg-sa-state-info-bg text-sa-state-info border-sa-state-info-border',
        agent: 'bg-sa-agent-bg text-sa-agent border-sa-agent-border',
        'coming-soon':
          'bg-[var(--sa-badge-coming-soon-bg)] text-[var(--sa-badge-coming-soon-text)] border-[var(--sa-badge-coming-soon-border)]',
      },
      size: {
        sm: 'text-xs px-1.5 py-0.5',
        md: 'text-xs px-2.5 py-1',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
)

export interface SaBadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof saBadgeVariants> {
  dot?: boolean
}

function SaBadge({
  className,
  variant = 'default',
  size = 'md',
  dot = false,
  children,
  ...props
}: SaBadgeProps) {
  return (
    <span
      data-slot="sa-badge"
      className={cn(saBadgeVariants({ variant, size, className }))}
      {...props}
    >
      {dot && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  )
}

export { SaBadge, saBadgeVariants }
