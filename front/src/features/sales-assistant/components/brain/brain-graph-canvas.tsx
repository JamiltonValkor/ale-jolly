'use client'

import { useEffect, useRef } from 'react'
import { MultiDirectedGraph } from 'graphology'
import Sigma from 'sigma'
import { EdgeArrowProgram, NodeCircleProgram } from 'sigma/rendering'
import {
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  ArrowsOut,
} from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { cn } from '@/lib/utils'
import { compactLabel, type BrainGraphModel } from '../../lib/brain-graph-model'

export interface BrainGraphCanvasLabels {
  zoomIn: string
  zoomOut: string
  reset: string
  canvas: string
}

interface Props {
  model: BrainGraphModel
  selectedId: string | null
  onSelect: (id: string) => void
  labels: BrainGraphCanvasLabels
  className?: string
}

/** Único archivo que importa sigma y graphology (regla no-restricted-imports); se carga con next/dynamic. */
function buildGraph(model: BrainGraphModel): MultiDirectedGraph {
  const graph = new MultiDirectedGraph()
  for (const node of model.nodes) {
    graph.addNode(node.id, {
      label: compactLabel(node.label, 22),
      x: node.x,
      y: node.y,
      size: node.size,
      color: node.color,
      type: 'circle',
    })
  }
  for (const edge of model.edges) {
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      color: '#3a3346',
      size: 0.6,
      type: 'arrow',
    })
  }
  return graph
}

function useSigma(model: BrainGraphModel, onSelect: (id: string) => void) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const sigma = new Sigma(buildGraph(model), container, {
      defaultEdgeType: 'arrow',
      nodeProgramClasses: { circle: NodeCircleProgram },
      edgeProgramClasses: { arrow: EdgeArrowProgram },
      labelColor: { color: '#e9e4f5' },
      labelRenderedSizeThreshold: 5,
      renderEdgeLabels: false,
    })
    sigma.on('clickNode', ({ node }) => onSelectRef.current(node))
    sigmaRef.current = sigma
    return () => {
      sigma.kill()
      sigmaRef.current = null
    }
  }, [model])
  return { containerRef, sigmaRef }
}

export function BrainGraphCanvas({
  model,
  selectedId,
  onSelect,
  labels,
  className,
}: Props) {
  const { containerRef, sigmaRef } = useSigma(model, onSelect)
  useEffect(() => {
    const sigma = sigmaRef.current
    if (!sigma) return
    const graph = sigma.getGraph()
    graph.forEachNode((id, attributes) => {
      graph.setNodeAttribute(id, 'highlighted', id === selectedId)
      graph.setNodeAttribute(
        id,
        'forceLabel',
        id === selectedId || attributes.forceLabel === true
      )
    })
    sigma.refresh()
  }, [selectedId, sigmaRef])
  const camera = () => sigmaRef.current?.getCamera()
  return (
    <div
      className={cn(
        'relative h-[420px] w-full overflow-hidden rounded-xl bg-[#14111b]',
        className
      )}
    >
      <div
        ref={containerRef}
        role="img"
        aria-label={labels.canvas}
        className="absolute inset-0"
      />
      <div className="absolute top-3 right-3 flex flex-col gap-2">
        <SaButton
          size="icon"
          variant="secondary"
          aria-label={labels.zoomIn}
          onClick={() => void camera()?.animatedZoom()}
        >
          <MagnifyingGlassPlus />
        </SaButton>
        <SaButton
          size="icon"
          variant="secondary"
          aria-label={labels.zoomOut}
          onClick={() => void camera()?.animatedUnzoom()}
        >
          <MagnifyingGlassMinus />
        </SaButton>
        <SaButton
          size="icon"
          variant="secondary"
          aria-label={labels.reset}
          onClick={() => void camera()?.animatedReset()}
        >
          <ArrowsOut />
        </SaButton>
      </div>
    </div>
  )
}
