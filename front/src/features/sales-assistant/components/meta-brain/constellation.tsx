'use client'

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { ConstellationEngine } from '../../lib/meta-brain/engine'
import { nextNode, type Direction } from '../../lib/meta-brain/navigation'
import type { MetaBrainFamily } from '../../lib/meta-brain/palette'
import type { SceneModel } from '../../lib/meta-brain/scene-model'
import { useBrainWords } from './brain-words'
import { NodeTooltip } from './node-tooltip'
import type { MetaBrainGraph } from './types'
import { useCanvasGestures } from './use-canvas-gestures'
import {
  useConstellationEngine,
  type HoverInfo,
} from './use-constellation-engine'
import styles from './meta-brain.module.css'

export interface ConstellationApi {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
}

interface Props {
  model: SceneModel
  graph: MetaBrainGraph
  day: number
  hidden: ReadonlySet<MetaBrainFamily>
  focusIds: Set<string> | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  insetLeft: number
  insetRight: number
  flyTo?: { id: string; seq: number } | null
  reduced: boolean
  apiRef?: RefObject<ConstellationApi | null>
  onEngage?: () => void
  className?: string
}

const ARROWS: Record<string, Direction> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

function useApi(
  engineRef: RefObject<ConstellationEngine | null>,
  apiRef?: RefObject<ConstellationApi | null>
) {
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      zoomIn: () => engineRef.current?.zoomBy(1.45),
      zoomOut: () => engineRef.current?.zoomBy(1 / 1.45),
      reset: () => engineRef.current?.reset(),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, engineRef])
}

/**
 * El grafo: un lienzo con el motor de la constelación, gestos, tooltip y
 * teclado (Tab entra, flechas recorren, Enter abre, Escape cierra). Lo que
 * se ve también se anuncia en una región viva.
 */
export function Constellation(props: Props) {
  const {
    model,
    graph,
    day,
    hidden,
    selectedId,
    onSelect,
    reduced,
    apiRef,
    onEngage,
    className,
  } = props
  const t = useTranslations('metaBrain.graph')
  const words = useBrainWords()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const instructionsId = useId()
  const [hover, setHover] = useState<{
    index: number
    x: number
    y: number
    flip: boolean
  } | null>(null)
  const [keyFocus, setKeyFocus] = useState(-1)
  const [dragging, setDragging] = useState(false)
  const onHover = (info: HoverInfo | null) =>
    setHover(
      info
        ? {
            ...info,
            flip: info.x > (wrapRef.current?.clientWidth ?? 1200) - 300,
          }
        : null
    )
  const engineRef = useConstellationEngine({
    canvasRef,
    wrapRef,
    model,
    reduced,
    onHover,
    view: { ...props, keyFocus },
  })
  useApi(engineRef, apiRef)
  const handlers = useCanvasGestures(wrapRef, engineRef, {
    onTap: index => onSelect(index >= 0 ? model.nodes[index].id : null),
    onEngage: () => onEngage?.(),
    onDragChange: setDragging,
  })
  const order = useMemo(
    () =>
      model.order.filter(
        i => model.nodes[i].day <= day && !hidden.has(model.nodes[i].family)
      ),
    [model, day, hidden]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const engine = engineRef.current
    if (event.key in ARROWS) {
      event.preventDefault()
      const next = nextNode(
        model.xs,
        model.ys,
        order,
        keyFocus >= 0 ? keyFocus : null,
        ARROWS[event.key]
      )
      if (next === null) return
      setKeyFocus(next)
      engine?.ensureVisible(next)
      onEngage?.()
    } else if ((event.key === 'Enter' || event.key === ' ') && keyFocus >= 0) {
      event.preventDefault()
      onSelect(model.nodes[keyFocus].id)
    } else if (event.key === 'Escape') {
      if (selectedId) onSelect(null)
      else setKeyFocus(-1)
    } else if (event.key === '+' || event.key === '=') engine?.zoomBy(1.45)
    else if (event.key === '-') engine?.zoomBy(1 / 1.45)
    else if (event.key === '0') engine?.reset()
  }

  const focused = keyFocus >= 0 ? model.nodes[keyFocus] : null
  const hovered = hover && hover.index >= 0 ? hover : null
  // El patrón WAI-ARIA para un lienzo con teclado propio es role="application":
  // las flechas, Enter y Escape se manejan aquí y se anuncian en la región viva.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      ref={wrapRef}
      role="application"
      tabIndex={0}
      aria-label={t('region')}
      aria-roledescription={t('roledescription')}
      aria-describedby={instructionsId}
      data-hovering={hovered ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      className={cn(styles.canvasWrap, className)}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyFocus(-1)}
      {...handlers}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <p id={instructionsId} className={styles.srOnly}>
        {t('instructions')}
      </p>
      <p className={styles.srOnly} aria-live="polite">
        {focused
          ? t('announce', {
              label: focused.label,
              family: words.family(focused.family),
              count: model.neighbors[keyFocus].length,
            })
          : ''}
      </p>
      {hovered && !dragging ? (
        <NodeTooltip
          node={graph.nodes[hovered.index]}
          x={hovered.x}
          y={hovered.y}
          flip={hovered.flip}
        />
      ) : null}
    </div>
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
