const DAY_MS = 86_400_000

/** Días completos desde `iso` (0 el mismo día); `null` si no hay fecha válida. */
export function daysSince(
  iso: string | null | undefined,
  now: Date
): number | null {
  if (!iso) return null
  const start = Date.parse(iso)
  if (Number.isNaN(start)) return null
  return Math.max(0, Math.floor((now.getTime() - start) / DAY_MS))
}

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** Saludo según la hora local: mañana 5–11, tarde 12–18, noche el resto. */
export function dayPart(now: Date): DayPart {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 19) return 'afternoon'
  return 'evening'
}

/** Primer nombre para el saludo («Nicolás García» → «Nicolás»). */
export function firstName(fullName: string | null | undefined): string | null {
  const name = fullName?.trim().split(/\s+/)[0]
  return name ? name : null
}
