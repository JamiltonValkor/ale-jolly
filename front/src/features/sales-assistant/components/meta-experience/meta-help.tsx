'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowsClockwise,
  Lightning,
  Question,
  Robot,
  ShieldCheck,
  type Icon,
} from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'
import { cn } from '@/lib/utils'

const ITEMS: {
  key: 'activate' | 'loop' | 'limits' | 'everywhere'
  icon: Icon
}[] = [
  { key: 'activate', icon: Lightning },
  { key: 'loop', icon: ArrowsClockwise },
  { key: 'limits', icon: ShieldCheck },
  { key: 'everywhere', icon: Robot },
]

function Key({ children }: { children: string }) {
  return (
    <kbd className="mu-mono inline-flex h-6 min-w-6 items-center justify-center rounded-[7px] bg-[rgba(255,255,255,0.08)] px-1.5 text-[12px] text-[var(--mu-fg)]">
      {children}
    </kbd>
  )
}

interface GuideProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pestañas visibles: 5 sin Stock, 6 con Stock. */
  tabCount?: number
}

/** «Cómo funciona»: lo esencial en cuatro filas y los atajos. */
export function MetaGuideDialog({
  open,
  onOpenChange,
  tabCount = 5,
}: GuideProps) {
  const t = useTranslations('metaExperience.help')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-meta-ui=""
        className={cn(
          META_UI_FONT_CLASS,
          'max-w-[560px] gap-0 rounded-[30px] border border-[rgba(255,255,255,0.1)] p-7'
        )}
      >
        <DialogTitle className="text-[26px] leading-[1.15] font-semibold tracking-[-0.025em]">
          {t('title')}
        </DialogTitle>
        <DialogDescription className="mt-2 text-[15px] leading-[1.55] text-[var(--mu-muted)]">
          {t('lead')}
        </DialogDescription>
        <ul className="mu-card mt-6">
          {ITEMS.map(({ key, icon: ItemIcon }) => (
            <li key={key} className="mu-row">
              <span className="mu-tile" aria-hidden>
                <ItemIcon size={17} weight="light" />
              </span>
              <div>
                <p className="text-[14.5px] leading-[1.35] font-medium">
                  {t(`items.${key}.title`)}
                </p>
                <p className="text-[13px] leading-[1.45] text-[var(--mu-text-ap)]">
                  {t(`items.${key}.body`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mu-label mt-6">{t('shortcutsTitle')}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-[13.5px]">
          <dt>
            <Key>/</Key>
          </dt>
          <dd className="text-[var(--mu-text-2)]">{t('shortcuts.chat')}</dd>
          <dt>
            <Key>{t('tabsKeys', { count: tabCount })}</Key>
          </dt>
          <dd className="text-[var(--mu-text-2)]">{t('shortcuts.tabs')}</dd>
        </dl>
        <div className="mt-7 flex justify-end">
          <button
            type="button"
            className="mu-btn mu-btn-p"
            onClick={() => onOpenChange(false)}
          >
            {t('close')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * El «?» de las pantallas sin pestañas (llegada, preparación): abre «Cómo
 * funciona». Con pestañas lo reemplaza `MetaTabHelp`, que explica la actual.
 */
export function MetaHelp() {
  const t = useTranslations('metaExperience.help')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="mu-btn mu-btn-ghost mu-btn-icon"
        aria-label={t('button')}
        onClick={() => setOpen(true)}
      >
        <Question size={18} weight="light" aria-hidden />
      </button>
      <MetaGuideDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
