'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { SaButton } from './sa-button'

export interface SaConfirmModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Main heading */
  title: string
  /** Bolder secondary line below the title */
  subtitle?: string
  /** Regular-weight body text */
  description?: string
  /** Primary (confirm) button label */
  confirmLabel: string
  /** Secondary (cancel) button label */
  cancelLabel: string
  /** Fires when the user clicks the confirm button */
  onConfirm: () => void
  /** Fires when the user clicks the cancel button */
  onCancel: () => void
  /** Fires when the modal is dismissed (X, overlay, Escape). Falls back to onCancel if not provided. */
  onDismiss?: () => void
  /** Show a loading spinner on the confirm button */
  isLoading?: boolean
  /** Visual style of the cancel button. Defaults to `outlined`. */
  cancelVariant?: 'outlined' | 'ghost'
  /**
   * `destructive` styles the confirm button with the error token (terminal,
   * irreversible actions). Defaults to the primary style.
   */
  tone?: 'default' | 'destructive'
  className?: string
  overlayClassName?: string
  /** Pass-through to DialogContent to customize the built-in close (X) button. */
  closeButtonClassName?: string
}

function SaConfirmModal({
  open,
  onOpenChange,
  title,
  subtitle,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  onDismiss,
  isLoading = false,
  cancelVariant = 'outlined',
  tone = 'default',
  className,
  overlayClassName,
  closeButtonClassName,
}: SaConfirmModalProps) {
  const handleOpenChange = (next: boolean) => {
    if (!next) (onDismiss ?? onCancel)()
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'border-sa-border-default rounded-[24px] bg-[#1d1d1d] p-6 sm:max-w-sm',
          className
        )}
        overlayClassName={overlayClassName}
        closeButtonClassName={closeButtonClassName}
      >
        <div className="flex flex-col">
          <DialogTitle className="text-sa-text-primary mb-2 font-sans text-[24px] font-normal">
            {title}
          </DialogTitle>

          {subtitle && (
            <p className="text-sa-text-secondary font-manrope text-[13px] font-normal">
              {subtitle}
            </p>
          )}

          {description && (
            <DialogDescription className="font-manrope text-[13px] text-white/80">
              {description}
            </DialogDescription>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <SaButton
            variant={tone === 'destructive' ? 'destructive' : 'primary'}
            size="lg"
            onClick={onConfirm}
            isLoading={isLoading}
            disabled={isLoading}
            className="w-full border-none"
          >
            {confirmLabel}
          </SaButton>

          <SaButton
            variant="secondary"
            size="lg"
            onClick={onCancel}
            disabled={isLoading}
            className={cn(
              'w-full',
              cancelVariant === 'outlined'
                ? 'border-1 border-[#7A7A7A]'
                : 'border-none bg-white/[0.04] hover:bg-white/[0.08]'
            )}
          >
            {cancelLabel}
          </SaButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { SaConfirmModal }
