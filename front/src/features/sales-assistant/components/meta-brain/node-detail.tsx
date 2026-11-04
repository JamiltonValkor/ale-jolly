'use client'

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { X } from '@phosphor-icons/react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { certaintyOf, type Certainty } from '../../lib/brain-v2'
import { familyOf } from '../../lib/meta-brain/palette'
import { nodeTime, type BrainTimeline } from '../../lib/meta-brain/time'
import { useBrainWords } from './brain-words'
import { FamilySwatch } from './family-legend'
import { NodeFeedback } from './node-feedback'
import { NodeRelations } from './node-relations'
import type {
  FeedbackInput,
  FeedbackState,
  MetaBrainGraph,
  MetaBrainNode,
} from './types'
import styles from './meta-brain.module.css'

interface Props {
  node: MetaBrainNode
  graph: MetaBrainGraph
  timeline: BrainTimeline
  feedback: FeedbackState
  onFeedback: (input: FeedbackInput) => void
  onClose: () => void
  onNavigate: (id: string) => void
  className?: string
}

export const CERTAINTY_TONE: Record<Certainty, string> = {
  verifiedData: 'var(--mu-ok)',
  youConfirmed: 'var(--mu-ok)',
  youSaid: 'var(--mu-violeta)',
  observed: 'rgba(255,255,255,0.6)',
  deduced: 'var(--mu-aviso)',
  proposed: 'var(--mu-aviso)',
  contradicted: 'var(--mu-mal)',
}

function Badge({ tone, children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className={styles.badge}
      style={tone ? ({ '--tone': tone } as CSSProperties) : undefined}
    >
      <span className={styles.badgeDot} aria-hidden="true" />
      {children}
    </span>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue} style={{ margin: 0 }}>
        {children}
      </dd>
    </div>
  )
}

function Facts({
  node,
  graph,
  timeline,
  onNavigate,
}: Pick<Props, 'node' | 'graph' | 'timeline' | 'onNavigate'>) {
  const t = useTranslations('metaBrain.detail')
  const words = useBrainWords()
  const format = useFormatter()
  const time = nodeTime(node)
  const replacement = node.superseded_by
    ? graph.nodes.find(n => n.id === node.superseded_by)
    : null
  return (
    <dl className={styles.facts}>
      {node.confidence ? (
        <Fact label={t('confidence')}>{words.confidence(node.confidence)}</Fact>
      ) : null}
      <Fact label={t('mentions')}>{node.mentions}</Fact>
      {node.evidence_count ? (
        <Fact label={t('evidence')}>{node.evidence_count}</Fact>
      ) : null}
      {time !== null ? (
        <Fact label={t('learned')}>
          {t('learnedValue', {
            date: format.dateTime(new Date(time), {
              day: 'numeric',
              month: 'short',
            }),
            day: timeline.nodeDay.get(node.id) ?? 1,
          })}
        </Fact>
      ) : null}
      {node.scope ? <Fact label={t('scope')}>{node.scope}</Fact> : null}
      {replacement ? (
        <Fact label={t('replacedBy')}>
          <button
            type="button"
            className={styles.linkButton}
            aria-label={t('goTo', { label: replacement.label })}
            onClick={() => onNavigate(replacement.id)}
          >
            {replacement.label}
          </button>
        </Fact>
      ) : null}
    </dl>
  )
}

/**
 * Lo que sabe de una idea: familia, certeza, etapa en palabras, cifras,
 * resumen, cómo se conecta, cómo llegó aquí y las acciones del dueño.
 */
export function NodeDetail({
  node,
  graph,
  timeline,
  feedback,
  onFeedback,
  onClose,
  onNavigate,
  className,
}: Props) {
  const t = useTranslations('metaBrain')
  const words = useBrainWords()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const family = familyOf(node.family)
  const certainty = certaintyOf(node)
  const rootRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [node.id])
  useEffect(() => {
    const root = rootRef.current
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      closeRef.current()
    }
    root?.addEventListener('keydown', onKey)
    return () => root?.removeEventListener('keydown', onKey)
  }, [])
  return (
    <aside
      ref={rootRef}
      aria-label={t('detail.label')}
      className={cn(styles.drawerScroll, className)}
    >
      <div className={styles.detailHead}>
        <span className={styles.familyChip}>
          <FamilySwatch family={family} />
          {words.family(family)}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          style={{ marginLeft: 'auto', background: 'transparent' }}
          aria-label={t('detail.close')}
          onClick={onClose}
        >
          <X size={16} weight="light" aria-hidden="true" />
        </button>
      </div>
      <h3 ref={titleRef} tabIndex={-1} className={styles.detailTitle}>
        {node.label}
      </h3>
      <div className={styles.badges}>
        <Badge tone={CERTAINTY_TONE[certainty]}>
          {t(`certainty.${certainty}`)}
        </Badge>
        {node.stage && node.stage !== 'vigente' ? (
          <Badge>{words.stage(node.stage)}</Badge>
        ) : null}
      </div>
      <p className={styles.summary}>{node.summary || t('detail.noSummary')}</p>
      <Facts
        node={node}
        graph={graph}
        timeline={timeline}
        onNavigate={onNavigate}
      />
      <NodeRelations nodeId={node.id} graph={graph} onNavigate={onNavigate} />
      <NodeFeedback nodeId={node.id} state={feedback} onFeedback={onFeedback} />
    </aside>
  )
}
