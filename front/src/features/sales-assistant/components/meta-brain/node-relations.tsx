'use client'

import { useMemo, useState } from 'react'
import { Path } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { relationsOf, type RelationLine } from '../../lib/meta-brain/describe'
import { pathOf } from '../../lib/brain-v2'
import { useBrainWords } from './brain-words'
import type { MetaBrainGraph } from './types'
import styles from './meta-brain.module.css'

interface Props {
  nodeId: string
  graph: MetaBrainGraph
  onNavigate: (id: string) => void
}

const VISIBLE = 6

function Relation({
  line,
  onNavigate,
}: {
  line: RelationLine
  onNavigate: (id: string) => void
}) {
  const t = useTranslations('metaBrain.detail')
  const words = useBrainWords()
  const other = (
    <button
      type="button"
      className={styles.linkButton}
      aria-label={t('goTo', { label: line.otherLabel })}
      onClick={() => onNavigate(line.otherId)}
    >
      {line.otherLabel}
    </button>
  )
  return (
    <li className={styles.relation}>
      {line.direction === 'out' ? (
        <>
          {t('selfStart')} {words.relation(line.relation)} {other}
        </>
      ) : (
        <>
          {other} {words.relation(line.relation)} {t('selfEnd')}
        </>
      )}
      {line.fact ? <span className={styles.fact2}>{line.fact}</span> : null}
    </li>
  )
}

function NodePath({
  graph,
  nodeId,
}: {
  graph: MetaBrainGraph
  nodeId: string
}) {
  const t = useTranslations('metaBrain.detail')
  const words = useBrainWords()
  const steps = useMemo(() => pathOf(graph, nodeId), [graph, nodeId])
  if (!steps.length) return <p className={styles.status}>{t('noPath')}</p>
  return (
    <ol aria-label={t('pathLabel')} className={styles.path}>
      {steps.map(step => (
        <li
          key={`${step.from.id}-${step.relation}-${step.to.id}`}
          className={styles.pathStep}
        >
          <span className={styles.strong}>{step.from.label}</span>{' '}
          {words.relation(step.relation)}{' '}
          <span className={styles.strong}>{step.to.label}</span>
        </li>
      ))}
    </ol>
  )
}

/** «Cómo se conecta» en frases y la ruta del loop hasta esta idea. */
export function NodeRelations({ nodeId, graph, onNavigate }: Props) {
  const t = useTranslations('metaBrain.detail')
  const [all, setAll] = useState(false)
  const [showPath, setShowPath] = useState(false)
  const lines = useMemo(() => relationsOf(graph, nodeId), [graph, nodeId])
  const shown = all ? lines : lines.slice(0, VISIBLE)
  return (
    <>
      <div className={styles.detailBlock}>
        <div className={styles.blockHead}>
          <span className="mu-label">{t('relations')}</span>
          {lines.length ? (
            <span className={styles.rowMeta}>
              {t('relationsCount', { count: lines.length })}
            </span>
          ) : null}
        </div>
        {lines.length ? (
          <ul className={styles.relations}>
            {shown.map(line => (
              <Relation key={line.key} line={line} onNavigate={onNavigate} />
            ))}
          </ul>
        ) : (
          <p className={styles.status}>{t('noRelations')}</p>
        )}
        {lines.length > VISIBLE ? (
          <button
            type="button"
            className={styles.ghostButton}
            style={{ alignSelf: 'flex-start', marginLeft: -12 }}
            onClick={() => setAll(v => !v)}
          >
            {all ? t('less') : t('more', { count: lines.length - VISIBLE })}
          </button>
        ) : null}
      </div>
      <div className={styles.detailBlock}>
        <button
          type="button"
          className={styles.ghostButton}
          style={{ alignSelf: 'flex-start', marginLeft: -12 }}
          aria-expanded={showPath}
          onClick={() => setShowPath(v => !v)}
        >
          <Path size={15} weight="light" aria-hidden="true" />
          {showPath ? t('hidePath') : t('showPath')}
        </button>
        {showPath ? <NodePath graph={graph} nodeId={nodeId} /> : null}
      </div>
    </>
  )
}
