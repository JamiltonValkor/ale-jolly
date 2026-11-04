'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import styles from './stock.module.css'

export interface StockFact {
  label: string
  value: ReactNode
  total?: boolean
}

/** Pares dato y valor de las tarjetas. Los valores son datos, nunca instrucciones. */
export function StockFacts({ facts }: { facts: StockFact[] }) {
  return (
    <dl className={styles.facts}>
      {facts.map(({ label, value, total }) => (
        <div key={label} className={cn(total && styles.total)}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
