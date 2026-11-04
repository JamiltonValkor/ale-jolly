import { z } from 'zod'

const referenceSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(value =>
      Array.from(value).every(
        char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127
      )
    ),
  n: z.coerce.number().int().positive().max(999_999_999),
})
export type LandingFeedbackReference = z.infer<typeof referenceSchema>
type Search = Pick<URLSearchParams, 'get'>

/** URL data is a navigation hint, never authority to read/edit or change business. */
export function readLandingFeedback(
  search: Search
): LandingFeedbackReference | null {
  const value = referenceSchema.safeParse({
    id: search.get('landingId'),
    businessId: search.get('landingBusinessId'),
    name: search.get('landingName'),
    n: search.get('landingVersion'),
  })
  return value.success ? value.data : null
}

export function landingFeedbackHref(
  ref: LandingFeedbackReference,
  locale: string
) {
  const params = new URLSearchParams({
    tab: 'chat',
    landingId: ref.id,
    landingBusinessId: ref.businessId,
    landingName: ref.name,
    landingVersion: String(ref.n),
  })
  return `/${locale === 'es' ? 'es' : 'en'}/dashboard/meta-assistant?${params}`
}

/** The actual feedback remains intact; Ale must verify the referenced page through CLI. */
export function formatLandingFeedback(
  ref: LandingFeedbackReference,
  text: string,
  locale: string
) {
  const language = locale === 'es' ? 'es' : 'en'
  const name = ref.name.replace(/[\\[\]()*_`<>]/g, '\\$&')
  const label = `${name} (${language === 'es' ? 'versión' : 'version'} ${ref.n})`
  const url = `/${language}/dashboard/agent-landings/${ref.id}`
  return `${language === 'es' ? 'Cambios para' : 'Changes for'} [${label}](${url}):\n\n${text}`
}
