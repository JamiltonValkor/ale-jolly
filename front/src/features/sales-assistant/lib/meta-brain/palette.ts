/**
 * Colores del cerebro del Meta Assistant. Salen de las paradas de la
 * iridiscencia (#FF86C8 #A98DFF #62C6FF #5FE3C0 #FFCF8F) y de sus mezclas,
 * más dos neutros tranquilos para el contexto y lo demás. Las apuestas y los
 * veredictos son el loop: se pintan casi blancos y con anillo propio.
 */
export const META_BRAIN_FAMILIES = [
  'identity',
  'offer',
  'market',
  'competition',
  'channels',
  'strategy',
  'bet',
  'verdict',
  'learned',
  'learning',
  'operations',
  'meta',
  'other',
] as const

export type MetaBrainFamily = (typeof META_BRAIN_FAMILIES)[number]

const KNOWN = new Set<string>(META_BRAIN_FAMILIES)

export function familyOf(value: string): MetaBrainFamily {
  return KNOWN.has(value) ? (value as MetaBrainFamily) : 'other'
}

export const FAMILY_COLOR: Record<MetaBrainFamily, string> = {
  identity: '#FF86C8',
  offer: '#FFCF8F',
  market: '#62C6FF',
  competition: '#E08BE0',
  channels: '#5FE3C0',
  strategy: '#A98DFF',
  bet: '#FFFFFF',
  verdict: '#FFF3DE',
  learned: '#F2E3A6',
  learning: '#C9E8A2',
  operations: '#B4C4FF',
  meta: '#9AA0AE',
  other: '#6E7380',
}

export const IRIDESCENCE = [
  '#FF86C8',
  '#A98DFF',
  '#62C6FF',
  '#5FE3C0',
  '#FFCF8F',
] as const

/** Anillo de un veredicto: funcionó, no funcionó o sigue abierto. */
export const OUTCOME_COLOR = {
  win: '#3DDC84',
  loss: '#FF9B95',
  open: '#F0C05A',
} as const

export type Outcome = keyof typeof OUTCOME_COLOR

export function isStandout(family: MetaBrainFamily): boolean {
  return family === 'bet' || family === 'verdict'
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}
