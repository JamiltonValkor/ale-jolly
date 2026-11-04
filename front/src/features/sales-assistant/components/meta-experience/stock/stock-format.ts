import { useLocale } from 'next-intl'
import { useCallback } from 'react'

/** Solo presenta el decimal que llega: el front no calcula dinero. */
export function formatStockMoney(
  value: string,
  currency: string,
  locale: string
): string {
  const amount = Number(value)
  return new Intl.NumberFormat(currency === 'COP' ? 'es-CO' : locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  })
    .format(amount)
    .replace(/(\p{Sc})\u00a0/u, '$1')
}

export function useStockMoney(currency: string) {
  const locale = useLocale()
  return useCallback(
    (value: string) => formatStockMoney(value, currency, locale),
    [currency, locale]
  )
}
