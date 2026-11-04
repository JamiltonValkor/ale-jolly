'use client'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SaButton } from '@/shared/components/sa-button'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  isPending: boolean
  /** Borrar usa el botón destructivo; desactivar, uno neutro. */
  destructive?: boolean
}

/**
 * Confirmación de desactivar o borrar (OCF-006). La acción segura (cancelar)
 * queda enfocada; mientras la acción corre no se puede cerrar ni repetir.
 * El diálogo no se cierra solo al confirmar: lo cierra la acción al terminar.
 */
export function LifecycleConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  isPending,
  destructive = false,
}: Props) {
  const handleOpenChange = (next: boolean) => {
    if (isPending && !next) return
    onOpenChange(next)
  }
  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="bg-sa-surface-popover border-sa-border-default rounded-[var(--sa-card-radius)]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sa-text-primary">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sa-text-secondary">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <SaButton
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco en la acción segura al abrir
            autoFocus
          >
            {cancelLabel}
          </SaButton>
          <SaButton
            variant={destructive ? 'destructive' : 'secondary'}
            onClick={onConfirm}
            disabled={isPending}
            isLoading={isPending}
            aria-busy={isPending || undefined}
          >
            {confirmLabel}
          </SaButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
