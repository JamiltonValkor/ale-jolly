import * as React from 'react'
import { cva } from 'class-variance-authority'
import type { Icon } from '@phosphor-icons/react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const iconVariants = cva(
  'mx-auto mb-4 flex size-12 items-center justify-center rounded-full',
  {
    variants: {
      variant: {
        default: 'bg-sa-interactive-primary/10 text-sa-interactive-primary',
        warning: 'bg-sa-state-warning-bg text-sa-state-warning',
        error: 'bg-sa-state-error-bg text-sa-state-error',
        success: 'bg-sa-state-success-bg text-sa-state-success',
        info: 'bg-sa-state-info-bg text-sa-state-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

const sizeClasses = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
} as const

export interface SaModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  icon?: Icon
  iconVariant?: 'default' | 'warning' | 'error' | 'success' | 'info'
  size?: 'sm' | 'md' | 'lg'
  topContent?: React.ReactNode
  hideTitle?: boolean
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

function SaModal({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon,
  iconVariant: iconVar = 'default',
  size = 'md',
  topContent,
  hideTitle = false,
  children,
  footer,
  className,
}: SaModalProps) {
  const showHeader = !hideTitle || !!Icon || !!description
  const hasTopContent = !!topContent

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'bg-sa-surface-elevated border-sa-border-default rounded-[24px]',
          hasTopContent && 'gap-0 p-0',
          sizeClasses[size],
          className
        )}
      >
        {topContent}
        {showHeader ? (
          <DialogHeader className={cn(hasTopContent && 'px-6 pt-6')}>
            {Icon && (
              <div className={iconVariants({ variant: iconVar })}>
                <Icon className="size-6" />
              </div>
            )}
            <DialogTitle
              className={cn(
                'text-sa-text-primary text-center',
                hideTitle && 'sr-only'
              )}
            >
              {title}
            </DialogTitle>
            {description && (
              <DialogDescription className="text-sa-text-secondary text-center">
                {description}
              </DialogDescription>
            )}
          </DialogHeader>
        ) : (
          <DialogTitle className="sr-only">{title}</DialogTitle>
        )}
        <div className={cn(hasTopContent && 'px-6 pt-5')}>{children}</div>
        {footer && (
          <DialogFooter className={cn(hasTopContent && 'px-6 pt-5 pb-6')}>
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

export { SaModal }
