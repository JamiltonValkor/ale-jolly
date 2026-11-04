import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

const saCardVariants = cva(
  'rounded-[var(--sa-card-radius)] border text-sa-text-primary',
  {
    variants: {
      variant: {
        default: 'bg-transparent border-sa-border-default',
        filled: 'bg-sa-surface-card border-sa-border-default',
        elevated:
          'bg-sa-surface-elevated border-sa-border-default shadow-sa-hover-glow',
        selected:
          'bg-[var(--sa-card-selected-bg)] border-[var(--sa-card-selected-border)]',
        interactive:
          'bg-transparent hover:bg-sa-surface-card-hover border-sa-border-default hover:border-sa-border-hover transition-colors cursor-pointer',
      },
      noPadding: {
        true: '[&_[data-slot=card-content]]:px-0 [&_[data-slot=card-header]]:px-0 [&_[data-slot=card-footer]]:px-0',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      noPadding: false,
    },
  }
)

export interface SaCardProps
  extends React.ComponentProps<'div'>, VariantProps<typeof saCardVariants> {}

function SaCard({
  className,
  variant = 'default',
  noPadding = false,
  ...props
}: SaCardProps) {
  return (
    <Card
      className={cn(saCardVariants({ variant, noPadding, className }))}
      {...props}
    />
  )
}

function SaCardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <CardHeader className={cn(className)} {...props} />
}

function SaCardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardTitle className={cn('text-sa-text-primary', className)} {...props} />
  )
}

function SaCardDescription({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <CardDescription
      className={cn('text-sa-text-secondary', className)}
      {...props}
    />
  )
}

function SaCardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <CardContent className={cn(className)} {...props} />
}

function SaCardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardFooter
      className={cn('border-sa-border-subtle border-t', className)}
      {...props}
    />
  )
}

export {
  SaCard,
  SaCardHeader,
  SaCardTitle,
  SaCardDescription,
  SaCardContent,
  SaCardFooter,
  saCardVariants,
}
