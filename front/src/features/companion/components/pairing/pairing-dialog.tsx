'use client'

import type { ReactNode } from 'react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'

import styles from './pairing.module.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  className?: string
}

/**
 * Modal de la sincronización (hoja inferior bajo 600 px). Radix atrapa el
 * foco y cierra con Esc; el portal vive fuera de `MetaUiScope`, así que el
 * contenido reabre el scope con `data-meta-ui` y las fuentes.
 */
export function PairingDialog({
  open,
  onOpenChange,
  children,
  className,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-meta-ui=""
        className={cn(META_UI_FONT_CLASS, styles.sheet, className)}
        overlayClassName={styles.veil}
        closeButtonClassName="hidden"
        // El paso enfoca su título (o el campo del código) al montarse.
        onOpenAutoFocus={event => event.preventDefault()}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}
