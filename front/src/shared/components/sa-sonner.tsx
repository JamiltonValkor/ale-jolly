'use client'

import { Check, Info, Warning, X, XCircle } from '@phosphor-icons/react'
import { type ReactNode } from 'react'
import { toast } from 'sonner'

// ─── Types ───────────────────────────────────────────────

interface BrandToastProps {
  message: string
  description?: string
  toastId: string | number
  icon: ReactNode
  bgClass: string
  borderClass: string
  iconColorClass: string
}

interface SaToastOptions {
  description?: string
  duration?: number
  /** Stable id: calling again with the same id updates the toast in place. */
  id?: string | number
  position?:
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | 'top-center'
    | 'bottom-center'
}

// ─── Constants ───────────────────────────────────────────

const BRAND_TOAST_CONTAINER =
  '!rounded-xl !border-none !bg-transparent !shadow-none !backdrop-blur-none !p-0 [&_[data-close-button]]:!hidden [&_button:has(svg)]:!bg-transparent [&_button:has(svg)]:!border-none [&_button:has(svg)_svg]:!text-current [&_button:has(svg)_path]:!text-current [&_button:has(svg)_svg]:!fill-current [&_button:has(svg)_path]:!fill-current [&_button:has(svg)_*]:!text-current'

const DEFAULT_DURATION = 4000
const DEFAULT_POSITION = 'bottom-right' as const

// ─── Base Component ──────────────────────────────────────

function BrandToast({
  message,
  description,
  toastId,
  icon,
  bgClass,
  borderClass,
  iconColorClass,
}: BrandToastProps) {
  return (
    <div
      className={`${borderClass} ${bgClass} flex w-full items-center gap-3 rounded-xl border px-3.5 py-3`}
    >
      <div className={`${iconColorClass} shrink-0`}>{icon}</div>
      <div className="flex-1">
        <p className="text-sa-text-primary text-sm">{message}</p>
        {description && (
          <p className="mt-0.5 text-xs text-white/50">{description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => toast.dismiss(toastId)}
        className="text-sa-text-tertiary hover:text-sa-text-primary shrink-0 transition-colors"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

// ─── Toast Variants ──────────────────────────────────────

function showBrandToast(
  message: string,
  icon: ReactNode,
  bgClass: string,
  borderClass: string,
  iconColorClass: string,
  options?: SaToastOptions
) {
  toast.custom(
    id => (
      <BrandToast
        message={message}
        description={options?.description}
        toastId={id}
        icon={icon}
        bgClass={bgClass}
        borderClass={borderClass}
        iconColorClass={iconColorClass}
      />
    ),
    {
      ...(options?.id !== undefined ? { id: options.id } : {}),
      duration: options?.duration ?? DEFAULT_DURATION,
      position: options?.position ?? DEFAULT_POSITION,
      unstyled: true,
      className: BRAND_TOAST_CONTAINER,
    }
  )
}

// ─── Public API ──────────────────────────────────────────

export const saToast = {
  success(message: string, options?: SaToastOptions) {
    showBrandToast(
      message,
      <Check weight="bold" className="size-6" />,
      'bg-[#0F1C19]',
      'border-[#34D39933]',
      'text-sa-state-success',
      options
    )
  },

  error(message: string, options?: SaToastOptions) {
    showBrandToast(
      message,
      <XCircle className="size-6" />,
      'bg-[#1C0F10]',
      'border-[#EF444433]',
      'text-sa-state-error',
      options
    )
  },

  warning(message: string, options?: SaToastOptions) {
    showBrandToast(
      message,
      <Warning className="size-6" />,
      'bg-[#1C1710]',
      'border-[#FBBF2433]',
      'text-sa-state-warning',
      options
    )
  },

  info(message: string, options?: SaToastOptions) {
    showBrandToast(
      message,
      <Info className="size-6" />,
      'bg-[#0F141C]',
      'border-[#60A5FA33]',
      'text-sa-state-info',
      options
    )
  },
}

// ─── Legacy exports (backward compatible) ────────────────

export function showBrandSaveSuccess(message: string) {
  saToast.success(message, { position: 'bottom-right' })
}

export function showBrandSaveError(message: string) {
  saToast.error(message, { position: 'bottom-right' })
}
