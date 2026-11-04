// TDD-SKIP: solo tipos de la API pública del cerebro (sin lógica que probar)
import type { RenderCompanion } from '../meta-experience/types'
import type {
  BrainBusinessGraphV2,
  BrainFeedbackAction,
  BrainSnapshotDiff,
  BrainSnapshots,
} from '../../types'

export type MetaBrainGraph = BrainBusinessGraphV2
export type MetaBrainNode = BrainBusinessGraphV2['nodes'][number]
export type SnapshotItem = BrainSnapshots['items'][number]

export type MetaBrainMode = 'graph' | 'sections' | 'changes'
export type MetaBrainStatus =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'error'
  | 'noBusiness'

export type FeedbackStatus =
  | 'idle'
  | 'pending'
  | 'sent'
  | 'queued'
  | 'error'
  | 'unavailable'

export interface FeedbackState {
  /** Idea a la que corresponde el estado (el resto se ve en reposo). */
  nodeId: string | null
  status: FeedbackStatus
  /** Confirmaciones de ideas anteriores: no se pierden al enviar otra. */
  settled?: Readonly<Record<string, 'sent' | 'queued'>>
}

export interface FeedbackInput {
  nodeId: string
  action: BrainFeedbackAction
  text?: string
}

export type ChangesStatus = 'idle' | 'loading' | 'ready' | 'notYet' | 'error'

export interface ChangesState {
  from: number | null
  to: number | null
  status: ChangesStatus
  diff: BrainSnapshotDiff | null
}

/** Vista presentacional completa de «Mi cerebro» (sin hooks de datos). */
export interface MetaBrainSceneProps {
  businessName: string
  status: MetaBrainStatus
  graph: MetaBrainGraph | null
  /** Fotos guardadas, la más nueva primero. */
  snapshots: SnapshotItem[]
  version: number | null
  onVersionChange?: (version: number) => void
  /** Asistente apagado: se ve la última foto y se dice. */
  stopped?: boolean
  onRetry?: () => void
  feedback: FeedbackState
  onFeedback: (input: FeedbackInput) => void
  changes: ChangesState
  onChangesRange?: (from: number, to: number) => void
  onChangesRetry?: () => void
  initialMode?: MetaBrainMode
  /** Idea abierta al entrar (enlace directo o laboratorio). */
  initialSelectedId?: string | null
  /** Día inicial de la línea de tiempo (por defecto, hoy). */
  initialDay?: number | null
  /** «Hoy» del cerebro en ms (por defecto, la fecha de la foto elegida). */
  today?: number | null
  /** Tu asistente en los estados sin cerebro todavía (lo pone la página). */
  renderCompanion?: RenderCompanion
  className?: string
}
