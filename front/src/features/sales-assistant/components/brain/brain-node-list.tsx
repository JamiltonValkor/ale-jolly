'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { BrainNode } from '../../types'

/** Mismos colores que el canvas (`BRAIN_FAMILY_COLORS`), como clases literales de Tailwind. */
const FAMILY_DOT: Record<BrainNode['family'], string> = {
  identity: 'bg-[#9b6cff]',
  offer: 'bg-[#5c8dff]',
  market: 'bg-[#38c4c9]',
  competition: 'bg-[#ef6666]',
  channels: 'bg-[#8fcf59]',
  strategy: 'bg-[#e2b44f]',
  operations: 'bg-[#7296ff]',
  learning: 'bg-[#d573dc]',
  meta: 'bg-[#7f8ca7]',
  learned: 'bg-[#b368d1]',
  other: 'bg-[#697288]',
}

interface Props {
  nodes: BrainNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  className?: string
}

/** Lista alternativa al canvas (sin WebGL o con lector de pantalla): mismos nodos, con teclado. */
export function BrainNodeList({
  nodes,
  selectedId,
  onSelect,
  className,
}: Props) {
  const t = useTranslations('salesAssistant.brain')
  return (
    <ul
      aria-label={t('listTitle')}
      className={cn(
        'flex max-h-[420px] flex-col gap-1 overflow-y-auto',
        className
      )}
    >
      {nodes.map(node => (
        <li key={node.id}>
          <button
            type="button"
            aria-pressed={node.id === selectedId}
            onClick={() => onSelect(node.id)}
            className={cn(
              'focus-visible:ring-sa-border-focus flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none focus-visible:ring-2',
              node.id === selectedId
                ? 'bg-sa-surface-elevated-active'
                : 'hover:bg-sa-surface-elevated'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-2.5 shrink-0 rounded-full',
                FAMILY_DOT[node.family]
              )}
            />
            <span className="text-sa-text-primary min-w-0 flex-1 truncate">
              {node.label}
            </span>
            <span className="text-sa-text-tertiary shrink-0 text-xs">
              {t(`family.${node.family}`)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
