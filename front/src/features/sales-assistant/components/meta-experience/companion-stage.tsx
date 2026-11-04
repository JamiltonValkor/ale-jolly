'use client'

import { cn } from '@/lib/utils'
import type {
  CompanionActionRequest,
  CompanionMood,
  CompanionSayRequest,
  CompanionSize,
  RenderCompanion,
} from './types'
import styles from './meta-experience.module.css'

interface Props {
  mood: CompanionMood
  size: CompanionSize
  label: string
  action?: CompanionActionRequest | null
  interactive?: boolean
  say?: CompanionSayRequest | null
  voice?: boolean
  renderCompanion?: RenderCompanion
  className?: string
}

const AI_MOODS = new Set<CompanionMood>([
  'syncing',
  'celebrating',
  'thinking',
  'working',
])

const SIZE_CLASS: Record<CompanionSize, string> = {
  hero: styles.stageHero,
  card: styles.stageCard,
  mini: styles.stageMini,
}

/**
 * Escenario del compañero: el personaje (lo pone la página) sobre un charco
 * de luz suave. En los momentos de IA aparece la iridiscencia, desenfocada.
 * Sin personaje, una silueta tranquila ocupa el mismo lugar (sin saltos).
 */
export function CompanionStage({
  mood,
  size,
  label,
  action = null,
  interactive = false,
  say = null,
  voice = false,
  renderCompanion,
  className,
}: Props) {
  return (
    <div
      className={cn(styles.stage, SIZE_CLASS[size], className)}
      data-ai={AI_MOODS.has(mood) ? 'true' : 'false'}
      data-mood={mood}
    >
      {renderCompanion ? (
        renderCompanion({ mood, size, label, action, interactive, say, voice })
      ) : (
        <div role="img" aria-label={label} className={styles.placeholder} />
      )}
    </div>
  )
}
