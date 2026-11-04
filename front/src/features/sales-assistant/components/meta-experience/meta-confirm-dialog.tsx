'use client'

import { useRef, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  isPending: boolean
  destructive?: boolean
  /** Contenido extra bajo la descripción (efectos, selector, errores). */
  children?: ReactNode
  confirmDisabled?: boolean
  /** Sin acción posible: solo queda volver. */
  hideConfirm?: boolean
}

/**
 * Confirmación con el lenguaje del chat nuevo. El contenido vive en un portal
 * fuera de la página, así que lleva su propio scope `data-meta-ui`.
 */
export function MetaConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  isPending,
  destructive = false,
  children,
  confirmDisabled = false,
  hideConfirm = false,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  return (
    <AlertDialog
      open={open}
      onOpenChange={next => (isPending ? undefined : onOpenChange(next))}
    >
      <AlertDialogContent
        data-meta-ui=""
        // Radix busca su propio Cancel y Trigger, que aquí no existen: con
        // contenido interactivo el foco entra al diálogo y vuelve al botón.
        onOpenAutoFocus={
          children
            ? event => {
                event.preventDefault()
                if (document.activeElement instanceof HTMLElement)
                  openerRef.current = document.activeElement
                cancelRef.current?.focus({ preventScroll: true })
              }
            : undefined
        }
        onCloseAutoFocus={
          children
            ? event => {
                event.preventDefault()
                openerRef.current?.focus({ preventScroll: true })
              }
            : undefined
        }
        className={cn(
          META_UI_FONT_CLASS,
          'max-w-[460px] gap-0 rounded-[30px] border border-[rgba(255,255,255,0.1)] p-7'
        )}
      >
        <AlertDialogTitle className="text-[23px] leading-[1.15] font-semibold tracking-[-0.025em]">
          {title}
        </AlertDialogTitle>
        <AlertDialogDescription className="mt-3 text-[14.5px] leading-[1.55] text-[var(--mu-muted)]">
          {description}
        </AlertDialogDescription>
        {children}
        <div className="mt-7 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="mu-btn"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {cancelLabel}
          </button>
          {hideConfirm ? null : (
            <button
              type="button"
              className={cn(
                'mu-btn',
                destructive ? 'mu-btn-danger' : 'mu-btn-p'
              )}
              onClick={onConfirm}
              aria-busy={isPending || undefined}
              disabled={isPending || confirmDisabled}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
