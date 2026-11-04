import { z } from 'zod'
import { ApiError, gatewayClient } from '@/lib/fetch/gateway-client'

/**
 * Moneda del presupuesto mensual del agente (AAF-004, V-F5): la de la cuenta
 * publicitaria verificada en Meta, igual que
 * `features/agent-chat/server/adapters/meta-selection.ts`. Nunca cae a la
 * moneda del negocio (`useAdAccountCurrency`). Sin cuenta verificada → null.
 */

const normalize = (value: string) => value.trim().replace(/^act_/i, '')

const configurationSchema = z.object({
  oauthData: z.object({
    selectedAdAccountId: z.string().nullish(),
    verifiedAdAccountCurrency: z
      .object({
        accountId: z.string(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullish(),
      })
      .nullish(),
  }),
})

export function adAccountCurrencyOf(raw: unknown): string | null {
  const parsed = configurationSchema.safeParse(raw)
  if (!parsed.success) return null
  const { selectedAdAccountId, verifiedAdAccountCurrency: account } =
    parsed.data.oauthData
  const selected = normalize(selectedAdAccountId ?? '')
  return selected && account && normalize(account.accountId) === selected
    ? (account.currency ?? null)
    : null
}

export async function fetchAdAccountCurrency(
  businessId: string
): Promise<string | null> {
  try {
    const raw = await gatewayClient.get<unknown>(
      '/api/integration/meta/configuration',
      { params: { businessId } }
    )
    return adAccountCurrencyOf(raw)
  } catch (error) {
    // Sin configuración de Meta: no hay moneda que fijar.
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}
