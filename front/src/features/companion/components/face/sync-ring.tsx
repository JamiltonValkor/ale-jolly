'use client'

import type { CSSProperties, ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

import styles from './sync-ring.module.css'

interface Props {
  /** 0–1 real; `null` cuando el back no informa el paso (sin número inventado). */
  progress: number | null
  label: string
  children: ReactNode
  className?: string
}

/**
 * Anillo iridiscente de la sincronización (la IA de Saleads trabajando):
 * luz suave y desenfocada que gira lento y se llena con el progreso real.
 */
export function SyncRing({ progress, label, children, className }: Props) {
  const reduced = useReducedMotion() ?? false
  const value = progress === null ? 0.3 : Math.min(1, Math.max(0, progress))
  const transition = reduced
    ? { duration: 0 }
    : { type: 'spring' as const, visualDuration: 1.1, bounce: 0.08 }
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress === null ? undefined : Math.round(value * 100)}
      className={cn(
        styles.ring,
        progress === null && styles.indeterminate,
        className
      )}
    >
      <motion.div
        aria-hidden="true"
        className={styles.layers}
        initial={false}
        animate={{ '--p': value } as Record<string, number>}
        transition={transition}
        style={{ '--p': value } as CSSProperties}
      >
        <div className={styles.glow}>
          <div className={styles.mask}>
            <div className={styles.spin} />
          </div>
        </div>
        <div className={styles.track} />
        <div className={styles.mask}>
          <div className={styles.spin} />
        </div>
      </motion.div>
      <div className={styles.content}>{children}</div>
    </div>
  )
}
