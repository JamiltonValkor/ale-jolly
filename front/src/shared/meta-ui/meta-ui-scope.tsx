import type { ComponentPropsWithoutRef } from 'react'
import { dmSans, jetbrainsMono } from '@/shared/fonts/google-fonts'
import { cn } from '@/lib/utils'
import './meta-ui.css'

interface Props extends ComponentPropsWithoutRef<'div'> {
  className?: string
}

/** Fuentes del chat nuevo (DM Sans + JetBrains Mono) para el scope Meta. */
export const META_UI_FONT_CLASS = `${dmSans.variable} ${jetbrainsMono.variable}`

/**
 * Raíz visual del Meta Assistant: aplica la paleta tinta sobre negro, DM Sans
 * y los puentes `--color-sa-*` a todo lo que contiene (ver `meta-ui.css`).
 */
export function MetaUiScope({ className, children, ...props }: Props) {
  return (
    <div
      data-meta-ui=""
      {...props}
      className={cn(META_UI_FONT_CLASS, className)}
    >
      {children}
    </div>
  )
}
