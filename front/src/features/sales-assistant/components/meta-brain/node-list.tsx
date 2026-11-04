'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  META_BRAIN_FAMILIES,
  type MetaBrainFamily,
} from '../../lib/meta-brain/palette'
import type { SceneModel, SceneNode } from '../../lib/meta-brain/scene-model'
import { useBrainWords } from './brain-words'
import { FamilySwatch } from './family-legend'
import styles from './meta-brain.module.css'

interface Props {
  model: SceneModel
  day: number
  hidden: ReadonlySet<MetaBrainFamily>
  focusIds: Set<string> | null
  selectedId: string | null
  onSelect: (id: string) => void
  className?: string
}

function groupsOf(
  model: SceneModel,
  day: number,
  hidden: ReadonlySet<string>,
  focus: Set<string> | null
) {
  const groups = new Map<MetaBrainFamily, SceneNode[]>()
  for (const index of model.order) {
    const node = model.nodes[index]
    if (
      node.day > day ||
      hidden.has(node.family) ||
      (focus && !focus.has(node.id))
    )
      continue
    groups.set(node.family, [...(groups.get(node.family) ?? []), node])
  }
  return META_BRAIN_FAMILIES.filter(f => groups.has(f)).map(
    f => [f, groups.get(f) ?? []] as const
  )
}

/**
 * «Ver como lista»: lo mismo que el grafo, agrupado por familia y en orden de
 * importancia, enfocable con Tab. Abre el mismo detalle.
 */
export function NodeList({
  model,
  day,
  hidden,
  focusIds,
  selectedId,
  onSelect,
  className,
}: Props) {
  const t = useTranslations('metaBrain')
  const words = useBrainWords()
  const groups = useMemo(
    () => groupsOf(model, day, hidden, focusIds),
    [model, day, hidden, focusIds]
  )
  if (!groups.length)
    return (
      <p className={cn(styles.status, className)}>
        {t('graph.nothingVisible')}
      </p>
    )
  return (
    <div
      aria-label={t('list.label')}
      role="region"
      className={cn(styles.listGroups, className)}
    >
      {groups.map(([family, nodes]) => (
        <div
          key={family}
          role="group"
          aria-label={`${words.family(family)}, ${t('list.count', { count: nodes.length })}`}
          className={styles.listGroup}
        >
          <div className={styles.listGroupHead} aria-hidden="true">
            <FamilySwatch family={family} />
            <span className="mu-label">{words.family(family)}</span>
            <span className={styles.rowMeta} style={{ marginLeft: 'auto' }}>
              {nodes.length}
            </span>
          </div>
          {nodes.map(node => (
            <button
              key={node.id}
              type="button"
              className={styles.rowButton}
              aria-current={node.id === selectedId ? 'true' : undefined}
              aria-label={t('list.open', { label: node.label })}
              onClick={() => onSelect(node.id)}
            >
              <span className={styles.rowLabel}>{node.label}</span>
              <span className={styles.rowMeta}>
                {t('changes.dayOf', { day: node.day })}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
