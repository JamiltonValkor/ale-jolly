'use client'

import type { ReactNode } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { changeLines, type ChangeLine } from '../../lib/meta-brain/describe'
import type { BrainTimeline } from '../../lib/meta-brain/time'
import type { BrainSnapshotDiff } from '../../types'
import { useBrainWords } from './brain-words'
import { NodeDetail } from './node-detail'
import { useReturnFocus } from './use-return-focus'
import type {
  ChangesState,
  FeedbackInput,
  FeedbackState,
  MetaBrainGraph,
  SnapshotItem,
} from './types'
import styles from './meta-brain.module.css'

interface Props {
  snapshots: SnapshotItem[]
  changes: ChangesState
  onRange?: (from: number, to: number) => void
  onRetry?: () => void
  graph: MetaBrainGraph | null
  timeline: BrainTimeline | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  feedback: FeedbackState
  onFeedback: (input: FeedbackInput) => void
  className?: string
}

type DiffNode = BrainSnapshotDiff['added'][number]

function useChangeText() {
  const t = useTranslations('metaBrain.changes')
  const words = useBrainWords()
  return (line: ChangeLine): string => {
    if (line.kind === 'stage') {
      if (!line.from && line.to)
        return t('stageNew', { to: words.stage(line.to) })
      if (!line.to) return t('stageGone')
      return t('stage', {
        from: words.stage(line.from ?? ''),
        to: words.stage(line.to),
      })
    }
    if (line.kind === 'confidence')
      return t(line.direction === 'up' ? 'confidenceUp' : 'confidenceDown', {
        from: words.confidence(line.from ?? '—'),
        to: words.confidence(line.to ?? '—'),
      })
    if (line.kind === 'label') return t('renamed', { to: line.to })
    return t('replaced')
  }
}

function Card({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  if (!count) return null
  return (
    <section aria-label={title} className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{title}</h3>
        <span className={styles.count}>{count}</span>
      </div>
      <ul className={styles.cardRows}>{children}</ul>
    </section>
  )
}

function Row({
  node,
  meta,
  canOpen,
  onOpen,
}: {
  node: DiffNode
  meta: string
  canOpen: boolean
  onOpen: () => void
}) {
  const content = (
    <span className={styles.memoryText}>
      <span className={styles.memoryLabel}>{node.label}</span>
      <span className={styles.memoryMeta}>{meta}</span>
    </span>
  )
  return (
    <li className={styles.cardRow}>
      {canOpen ? (
        <button type="button" className={styles.memory} onClick={onOpen}>
          {content}
          <CaretRight
            className={styles.chevron}
            size={14}
            weight="light"
            aria-hidden="true"
          />
        </button>
      ) : (
        <div className={styles.memory} style={{ cursor: 'default' }}>
          {content}
        </div>
      )}
    </li>
  )
}

function RangePicker({
  snapshots,
  changes,
  onRange,
}: Pick<Props, 'snapshots' | 'changes' | 'onRange'>) {
  const t = useTranslations('metaBrain')
  const format = useFormatter()
  const option = (item: SnapshotItem) =>
    t('photos.option', {
      date: format.dateTime(new Date(item.created_at), {
        day: 'numeric',
        month: 'short',
      }),
      count: item.node_count,
    })
  const from = changes.from ?? snapshots[1]?.version ?? 0
  const to = changes.to ?? snapshots[0]?.version ?? 0
  return (
    <div className={styles.toolbar}>
      {(
        [
          ['from', from],
          ['to', to],
        ] as const
      ).map(([key, value]) => (
        <label key={key} className={styles.field}>
          <span className="mu-label">{t(`changes.${key}`)}</span>
          <select
            className={styles.select}
            value={value}
            onChange={event => {
              const next = Number(event.target.value)
              onRange?.(key === 'from' ? next : from, key === 'to' ? next : to)
            }}
          >
            {snapshots.map(item => (
              <option key={item.version} value={item.version}>
                {option(item)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  )
}

function DiffBody({
  diff,
  snapshots,
  graph,
  timeline,
  onSelect,
}: { diff: BrainSnapshotDiff } & Pick<
  Props,
  'snapshots' | 'graph' | 'timeline' | 'onSelect'
>) {
  const t = useTranslations('metaBrain.changes')
  const words = useBrainWords()
  const format = useFormatter()
  const text = useChangeText()
  const date = (version: number) => {
    const item = snapshots.find(s => s.version === version)
    return item
      ? format.dateTime(new Date(item.created_at), {
          day: 'numeric',
          month: 'long',
        })
      : '—'
  }
  const known = new Set(graph?.nodes.map(n => n.id) ?? [])
  const dayMeta = (node: DiffNode) => {
    const day = timeline?.nodeDay.get(node.id)
    return [words.family(node.family), day ? t('dayOf', { day }) : null]
      .filter(Boolean)
      .join(' · ')
  }
  const total = diff.counts.added + diff.counts.modified + diff.counts.removed
  return (
    <>
      <p className={styles.changeSummary}>
        {t('summary', {
          from: date(diff.from),
          to: date(diff.to),
          ...diff.counts,
        })}
      </p>
      {!total ? <p className={styles.plainMessage}>{t('nothing')}</p> : null}
      <div className={styles.cards}>
        <Card title={t('added')} count={diff.added.length}>
          {diff.added.map(node => (
            <Row
              key={node.id}
              node={node}
              meta={dayMeta(node)}
              canOpen={known.has(node.id)}
              onOpen={() => onSelect(node.id)}
            />
          ))}
        </Card>
        <Card title={t('modified')} count={diff.modified.length}>
          {diff.modified.map(change => (
            <Row
              key={change.id}
              node={change.after}
              meta={changeLines(change.before, change.after)
                .map(text)
                .join(' ')}
              canOpen={known.has(change.id)}
              onOpen={() => onSelect(change.id)}
            />
          ))}
        </Card>
        <Card title={t('removed')} count={diff.removed.length}>
          {diff.removed.map(node => (
            <Row
              key={node.id}
              node={node}
              meta={words.family(node.family)}
              canOpen={false}
              onOpen={() => undefined}
            />
          ))}
        </Card>
      </div>
    </>
  )
}

function Message({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const t = useTranslations('metaBrain.changes')
  return (
    <div className={styles.plainMessage} role={onRetry ? 'alert' : 'status'}>
      {text}
      {onRetry ? (
        <div className={styles.messageActions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onRetry}
          >
            {t('retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** «Qué cambió» entre dos fotos, en frases: lo nuevo, lo que cambió y lo retirado. */
export function ChangesView(props: Props) {
  const {
    snapshots,
    changes,
    graph,
    timeline,
    selectedId,
    onSelect,
    className,
  } = props
  const t = useTranslations('metaBrain.changes')
  const selected = selectedId
    ? graph?.nodes.find(n => n.id === selectedId)
    : undefined
  const focusReturn = useReturnFocus()
  const open = (id: string | null) => {
    if (!selectedId) focusReturn.remember()
    onSelect(id)
  }
  const close = () => {
    onSelect(null)
    focusReturn.restore()
  }
  if (snapshots.length < 2) return <Message text={t('needTwo')} />
  const same = changes.from !== null && changes.from === changes.to
  return (
    <div
      className={cn(styles.withDrawer, className)}
      data-open={selected ? 'true' : 'false'}
    >
      <div>
        <RangePicker
          snapshots={snapshots}
          changes={changes}
          onRange={props.onRange}
        />
        {same ? <Message text={t('same')} /> : null}
        {!same && changes.status === 'loading' ? (
          <p role="status" className={styles.plainMessage}>
            {t('loading')}
          </p>
        ) : null}
        {!same && changes.status === 'notYet' ? (
          <Message text={t('notYet')} />
        ) : null}
        {!same && changes.status === 'error' ? (
          <Message text={t('error')} onRetry={props.onRetry} />
        ) : null}
        {!same && changes.status === 'ready' && changes.diff ? (
          <DiffBody
            diff={changes.diff}
            snapshots={snapshots}
            graph={graph}
            timeline={timeline}
            onSelect={open}
          />
        ) : null}
      </div>
      {selected && graph && timeline ? (
        <div className={styles.sideDrawer}>
          <NodeDetail
            node={selected}
            graph={graph}
            timeline={timeline}
            feedback={props.feedback}
            onFeedback={props.onFeedback}
            onClose={close}
            onNavigate={onSelect}
          />
        </div>
      ) : null}
    </div>
  )
}
