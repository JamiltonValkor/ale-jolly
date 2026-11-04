import type { AgentAction } from '../types'
import { minorToMajor } from './agent-money'

/**
 * Frase simple de una acción de la traza (AAF-005, lista de C-18): clave i18n
 * de `autonomousTeam.kind.*` + valores. `request_args` es libre por `kind`, así
 * que se lee con guardas (lista blanca de AAB-010); lo desconocido cae a
 * `request_summary` o a «Ale hizo un cambio».
 */

export type MoneyFormatter = (amount: number, currency: string) => string

export type AgentActionCopy =
  | { kind: 'key'; key: string; values: Record<string, string | number> }
  | { kind: 'text'; text: string }

const OBJECT_TYPES = new Set(['ad_set', 'ad', 'campaign'])

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const withName = (key: string, name: string | null, field: string) =>
  name
    ? { kind: 'key' as const, key, values: { [field]: name } }
    : { kind: 'key' as const, key: `${key}Unnamed`, values: {} }

const campaignName = (args: Record<string, unknown>) => {
  const name = text(args.campaign_name)
  return name ? name.replace(/^\[Ale\]\s*/, '') : null
}

function budgetCopy(
  args: Record<string, unknown>,
  formatMoney: MoneyFormatter
): AgentActionCopy {
  const minor = int(args.to_minor)
  const currency = text(args.currency)
  if (minor === null || !currency)
    return { kind: 'key', key: 'budget_changeUnnamed', values: {} }
  const amount = formatMoney(minorToMajor(minor, currency), currency)
  const box = text(args.ad_set_name)
  return box
    ? { kind: 'key', key: 'budget_change', values: { amount, box } }
    : { kind: 'key', key: 'budget_changeNoBox', values: { amount } }
}

function objectCopy(
  kind: 'pause' | 'resume',
  args: Record<string, unknown>,
  subjectType: string
): AgentActionCopy {
  const raw = text(args.object_type) ?? subjectType
  const type = OBJECT_TYPES.has(raw) ? raw : 'other'
  const name = text(args.object_name)
  return name
    ? { kind: 'key', key: kind, values: { type, name } }
    : { kind: 'key', key: `${kind}Unnamed`, values: { type } }
}

const FIXED = new Set([
  'media_uploaded',
  'duplicate_box',
  'add_ads',
  'delete',
  'lead_quality',
  'sale',
])

export function agentActionCopy(
  action: AgentAction,
  formatMoney: MoneyFormatter
): AgentActionCopy {
  const args = action.request_args ?? {}
  switch (action.kind) {
    case 'bet_created':
      return withName('bet_created', action.bet_ref?.bet_label ?? null, 'bet')
    case 'structure_published':
    case 'activation_requested':
    case 'launch':
    case 'activation':
      return withName(action.kind, campaignName(args), 'campaign')
    case 'creative_rendered': {
      const credits = int(args.credits_settled)
      return credits === null
        ? { kind: 'key', key: 'creative_renderedUnnamed', values: {} }
        : { kind: 'key', key: 'creative_rendered', values: { credits } }
    }
    case 'budget_change':
      return budgetCopy(args, formatMoney)
    case 'pause':
    case 'resume':
      return objectCopy(action.kind, args, action.subject_type)
    default:
      if (FIXED.has(action.kind))
        return { kind: 'key', key: action.kind, values: {} }
      return action.request_summary
        ? { kind: 'text', text: action.request_summary }
        : { kind: 'key', key: 'other', values: {} }
  }
}
