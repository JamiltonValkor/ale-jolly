'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Question, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { FAMILY_COLOR, OUTCOME_COLOR } from '../../lib/meta-brain/palette'
import { FamilySwatch } from './family-legend'
import styles from './meta-brain.module.css'

interface Props {
  className?: string
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <span className={styles.guideMark} aria-hidden="true">
      {children}
    </span>
  )
}

const dot = (color: string, size = 9) =>
  ({
    width: size,
    height: size,
    borderRadius: 999,
    background: color,
    display: 'inline-block',
  }) as CSSProperties

function GuideItems() {
  const t = useTranslations('metaBrain.guide')
  const items: Array<[ReactNode, string]> = [
    [<span key="c" style={dot(FAMILY_COLOR.market)} />, t('color')],
    [<span key="s" style={dot('rgba(255,255,255,.8)', 13)} />, t('size')],
    [<FamilySwatch key="b" family="bet" />, t('bet')],
    [
      <span
        key="v"
        style={{
          ...dot('transparent', 11),
          boxShadow: `inset 0 0 0 1.4px ${OUTCOME_COLOR.win}`,
        }}
      />,
      t('verdict'),
    ],
    [
      <span
        key="l"
        style={{
          width: 16,
          height: 1,
          background: 'rgba(255,255,255,.4)',
          display: 'inline-block',
        }}
      />,
      t('lines'),
    ],
    [<span key="p" style={dot('#fff', 5)} />, t('pulses')],
    [
      <span
        key="t"
        style={{
          width: 3,
          height: 12,
          borderRadius: 2,
          background: 'rgba(255,255,255,.6)',
          display: 'inline-block',
        }}
      />,
      t('timeline'),
    ],
  ]
  return (
    <ul className={styles.guideList}>
      {items.map(([mark, text]) => (
        <li key={text} className={styles.guideItem}>
          <Mark>{mark}</Mark>
          <span>{text}</span>
        </li>
      ))}
    </ul>
  )
}

/** «Cómo leerlo»: ayuda a la mano sobre qué significa cada color, anillo y pulso. */
export function ReadingGuide({ className }: Props) {
  const t = useTranslations('metaBrain.guide')
  const [open, setOpen] = useState(false)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const root = rootRef.current
    const onDown = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    root?.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      root?.removeEventListener('keydown', onKey)
    }
  }, [open])
  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }
  return (
    <div ref={rootRef} className={cn(styles.popoverAnchor, className)}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.ghostButton}
        aria-label={t('open')}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(v => !v)}
      >
        <Question size={16} weight="light" aria-hidden="true" />
        <span className={styles.ghostLabel}>{t('open')}</span>
      </button>
      {open ? (
        <div id={id} className={styles.guide}>
          <div className={styles.guideHead}>
            <h3
              id={`${id}-title`}
              tabIndex={-1}
              style={{ margin: 0, fontSize: 'inherit' }}
            >
              {t('title')}
            </h3>
            <button
              type="button"
              className={styles.searchClear}
              aria-label={t('close')}
              onClick={close}
            >
              <X size={14} weight="light" aria-hidden="true" />
            </button>
          </div>
          <GuideItems />
        </div>
      ) : null}
    </div>
  )
}
