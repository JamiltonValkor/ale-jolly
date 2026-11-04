import type { BrainSnapshotAny, BrainSnapshots } from '../../types/orqa.schemas'

export interface BrainCounts {
  ideas: number | null
  bets: number | null
  learned: number | null
}

/**
 * Cifras del cerebro para «Hoy»: ideas (nodos de la última foto), apuestas
 * activas y aprendizajes (secciones v2). Lo que no se sabe queda en `null`,
 * para mostrar «—» y no un cero inventado.
 */
export function brainCounts(
  snapshots: BrainSnapshots | undefined,
  latest: BrainSnapshotAny | undefined
): BrainCounts {
  const ideas = latest?.node_count ?? snapshots?.items[0]?.node_count ?? null
  const graph: unknown = latest?.graph
  const sections =
    graph && typeof graph === 'object' && 'sections' in graph
      ? (graph as { sections: Record<string, unknown> }).sections
      : null
  const count = (key: string) => {
    const list = sections?.[key]
    return Array.isArray(list) ? list.length : null
  }
  return { ideas, bets: count('active_bets'), learned: count('learned') }
}
