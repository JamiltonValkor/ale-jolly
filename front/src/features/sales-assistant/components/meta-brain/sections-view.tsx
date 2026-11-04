'use client'

import { useMemo, useState } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { certaintyOf, SECTION_ORDER, type Certainty } from '../../lib/brain-v2'
import type { InsightFocus } from '../../lib/meta-brain/focus'
import type { BrainTimeline } from '../../lib/meta-brain/time'
import type { BrainSection } from '../../types'
import { useBrainWords } from './brain-words'
import { NodeDetail } from './node-detail'
import { useReturnFocus } from './use-return-focus'
import type {
  FeedbackInput,
  FeedbackState,
  MetaBrainGraph,
  MetaBrainNode,
} from './types'
import styles from './meta-brain.module.css'

interface Props {
  graph: MetaBrainGraph
  timeline: BrainTimeline
  focus: InsightFocus
  selectedId: string | null
  onSelect: (id: string | null) => void
  feedback: FeedbackState
  onFeedback: (input: FeedbackInput) => void
  className?: string
}

const CERTAINTIES: readonly Certainty[] = [
  'verifiedData',
  'youConfirmed',
  'youSaid',
  'observed',
  'deduced',
  'proposed',
  'contradicted',
]
const FOCUS_SECTIONS: Record<InsightFocus, BrainSection[] | null> = {
  all: null,
  bets: ['active_bets'],
  learned: ['learned', 'did_not_work'],
  toConfirm: ['to_confirm'],
}
const VISIBLE = 6

function MemoryRow({
  node,
  current,
  onOpen,
}: {
  node: MetaBrainNode
  current: boolean
  onOpen: () => void
}) {
  const t = useTranslations('metaBrain')
  const words = useBrainWords()
  const meta = [
    t(`certainty.${certaintyOf(node)}`),
    node.stage && node.stage !== 'vigente' ? words.stage(node.stage) : null,
    node.evidence_count
      ? t('sections.evidence', { count: node.evidence_count })
      : null,
  ].filter(Boolean)
  return (
    <li className={styles.cardRow}>
      <button
        type="button"
        className={styles.memory}
        aria-current={current ? 'true' : undefined}
        onClick={onOpen}
      >
        <span className={styles.memoryText}>
          <span className={styles.memoryLabel}>{node.label}</span>
          <span className={styles.memoryMeta}>{meta.join(' · ')}</span>
        </span>
        <CaretRight
          className={styles.chevron}
          size={14}
          weight="light"
          aria-hidden="true"
        />
      </button>
    </li>
  )
}

function SectionCard({
  section,
  nodes,
  selectedId,
  onSelect,
}: {
  section: BrainSection
  nodes: MetaBrainNode[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const t = useTranslations('metaBrain.sections')
  const [all, setAll] = useState(false)
  const shown = all ? nodes : nodes.slice(0, VISIBLE)
  const id = `brain-section-${section}`
  return (
    <section aria-labelledby={id} className={styles.card}>
      <div className={styles.cardHead}>
        <h3 id={id} className={styles.cardTitle}>
          {t(`titles.${section}`)}
        </h3>
        <span className={styles.count}>{nodes.length}</span>
      </div>
      {nodes.length ? (
        <ul className={styles.cardRows}>
          {shown.map(node => (
            <MemoryRow
              key={node.id}
              node={node}
              current={node.id === selectedId}
              onOpen={() => onSelect(node.id)}
            />
          ))}
        </ul>
      ) : (
        <p className={styles.cardEmpty}>{t(`empty.${section}`)}</p>
      )}
      {nodes.length > VISIBLE ? (
        <div className={styles.cardFoot}>
          <button
            type="button"
            className={styles.ghostButton}
            aria-expanded={all}
            onClick={() => setAll(v => !v)}
          >
            {all ? t('less') : t('more', { count: nodes.length })}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function Filters({
  scope,
  setScope,
  certainty,
  setCertainty,
}: {
  scope: 'current' | 'history'
  setScope: (s: 'current' | 'history') => void
  certainty: Certainty | 'all'
  setCertainty: (c: Certainty | 'all') => void
}) {
  const t = useTranslations('metaBrain')
  return (
    <div className={styles.toolbar}>
      <div className={styles.field}>
        <span className="mu-label">{t('sections.scope')}</span>
        <div className={styles.segmented}>
          {(['current', 'history'] as const).map(value => (
            <button
              key={value}
              type="button"
              className={styles.segment}
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {t(`sections.${value}`)}
            </button>
          ))}
        </div>
      </div>
      <label className={styles.field}>
        <span className="mu-label">{t('sections.certaintyFilter')}</span>
        <select
          className={styles.select}
          value={certainty}
          onChange={event =>
            setCertainty(event.target.value as Certainty | 'all')
          }
        >
          <option value="all">{t('sections.all')}</option>
          {CERTAINTIES.map(c => (
            <option key={c} value={c}>
              {t(`certainty.${c}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** «Por secciones»: apuestas, aprendizajes, lo que no funcionó, correcciones, pendientes y el negocio. */
export function SectionsView({
  graph,
  timeline,
  focus,
  selectedId,
  onSelect,
  feedback,
  onFeedback,
  className,
}: Props) {
  const [scope, setScope] = useState<'current' | 'history'>('current')
  const [certainty, setCertainty] = useState<Certainty | 'all'>('all')
  const byId = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph])
  const sections = (FOCUS_SECTIONS[focus] ?? SECTION_ORDER).filter(s =>
    scope === 'history' ? s === 'history' : s !== 'history'
  )
  const nodesOf = (section: BrainSection) =>
    (graph.sections[section] ?? [])
      .map(id => byId.get(id))
      .filter((n): n is MetaBrainNode => !!n)
      .filter(n => certainty === 'all' || certaintyOf(n) === certainty)
  const selected = selectedId ? byId.get(selectedId) : undefined
  const focusReturn = useReturnFocus()
  const open = (id: string) => {
    if (!selectedId) focusReturn.remember()
    onSelect(id)
  }
  const close = () => {
    onSelect(null)
    focusReturn.restore()
  }
  return (
    <div
      className={cn(styles.withDrawer, className)}
      data-open={selected ? 'true' : 'false'}
    >
      <div>
        <Filters
          scope={scope}
          setScope={setScope}
          certainty={certainty}
          setCertainty={setCertainty}
        />
        <div className={styles.cards}>
          {sections.map(section => (
            <SectionCard
              key={section}
              section={section}
              nodes={nodesOf(section)}
              selectedId={selectedId}
              onSelect={open}
            />
          ))}
        </div>
      </div>
      {selected ? (
        <div className={styles.sideDrawer}>
          <NodeDetail
            node={selected}
            graph={graph}
            timeline={timeline}
            feedback={feedback}
            onFeedback={onFeedback}
            onClose={close}
            onNavigate={onSelect}
          />
        </div>
      ) : null}
    </div>
  )
}
