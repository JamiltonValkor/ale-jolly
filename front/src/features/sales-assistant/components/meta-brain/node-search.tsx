'use client'

import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { searchNodes } from '../../lib/meta-brain/focus'
import { familyOf } from '../../lib/meta-brain/palette'
import { useBrainWords } from './brain-words'
import { FamilySwatch } from './family-legend'
import type { MetaBrainNode } from './types'
import styles from './meta-brain.module.css'

interface Props {
  nodes: MetaBrainNode[]
  onPick: (id: string) => void
  className?: string
}

/** Combobox para encontrar una idea por nombre (sin tildes ni mayúsculas). */
export function NodeSearch({ nodes, onPick, className }: Props) {
  const t = useTranslations('metaBrain.search')
  const words = useBrainWords()
  const id = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const results = useMemo(() => searchNodes(nodes, query), [nodes, query])
  const open = query.trim().length > 0
  const pick = (node: MetaBrainNode | undefined) => {
    if (!node) return
    onPick(node.id)
    setQuery('')
    setActive(-1)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!results.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(current => (current + step + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(results[active] ?? results[0])
    } else if (event.key === 'Escape') {
      setQuery('')
      setActive(-1)
    }
  }
  return (
    <div className={cn(styles.search, className)}>
      <div className={styles.searchField}>
        <MagnifyingGlass size={15} weight="light" aria-hidden="true" />
        <input
          role="combobox"
          aria-label={t('label')}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 ? `${id}-opt-${active}` : undefined
          }
          className={styles.searchInput}
          placeholder={t('placeholder')}
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button
            type="button"
            className={styles.searchClear}
            aria-label={t('clear')}
            onClick={() => setQuery('')}
          >
            <X size={13} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className={styles.srOnly} aria-live="polite">
        {open ? t('results', { count: results.length }) : ''}
      </p>
      {open ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={t('label')}
          className={styles.listbox}
        >
          {results.length ? (
            results.map((node, index) => (
              <li
                key={node.id}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                className={styles.option}
                onMouseDown={event => event.preventDefault()}
                onClick={() => pick(node)}
                onKeyDown={event => event.key === 'Enter' && pick(node)}
              >
                <FamilySwatch family={familyOf(node.family)} />
                <span>{node.label}</span>
                <span className={styles.optionFamily}>
                  {words.family(node.family)}
                </span>
              </li>
            ))
          ) : (
            <li
              role="option"
              aria-selected={false}
              aria-disabled="true"
              className={styles.listboxEmpty}
            >
              {t('empty', { query: query.trim() })}
            </li>
          )}
        </ul>
      ) : null}
    </div>
  )
}
