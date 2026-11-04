import type { useFormatter } from 'next-intl'

export interface Money {
  amount: number
  currency: string
}

/** `MoneyV1` (unidades mayores) en la moneda de la cuenta; sin decimales si el monto es entero. */
export function formatMoney(
  format: ReturnType<typeof useFormatter>,
  money: Money
): string {
  return format.number(money.amount, {
    style: 'currency',
    currency: money.currency,
    maximumFractionDigits: Number.isInteger(money.amount) ? 0 : 2,
  })
}
