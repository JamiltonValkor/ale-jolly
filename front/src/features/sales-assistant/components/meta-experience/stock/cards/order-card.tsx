'use client'

import { useTranslations } from 'next-intl'
import type { StockProposalOf } from '../../../../types'
import { StockFacts } from '../stock-facts'
import { useStockMoney } from '../stock-format'
import styles from '../stock.module.css'

interface Props {
  proposal: StockProposalOf<'pedido'>
}

/** El contrato usa 0 y «Sin dato» juntos cuando la cotización no trae el plazo. */
const NO_QUOTE_DATA = 'Sin dato'

/** Pedido: costo total por proveedor (R25), equivalencia (R26) y mandato (R27). */
export function OrderCard({ proposal }: Props) {
  const t = useTranslations('metaExperience.stock.order')
  const { detalle } = proposal
  const money = useStockMoney(detalle.moneda)
  const { mandato } = detalle
  return (
    <div className={styles.stack}>
      <table className={styles.table}>
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('supplier')}</th>
            <th scope="col">{t('price')}</th>
            <th scope="col">{t('freight')}</th>
            <th scope="col">{t('minimum')}</th>
            <th scope="col">{t('delivery')}</th>
            <th scope="col">{t('payment')}</th>
            <th scope="col">{t('warranty')}</th>
            <th scope="col">{t('total')}</th>
          </tr>
        </thead>
        <tbody>
          {detalle.proveedores.map(supplier => (
            <tr
              key={supplier.nombre}
              className={supplier.elegido ? styles.picked : undefined}
            >
              <td>
                <span className={styles.pname}>{supplier.nombre}</span>
                <span className={styles.pmeta}>
                  {supplier.elegido ? `${t('chosen')} · ` : null}
                  {t(`equivalence.${supplier.equivalencia}`)}
                </span>
              </td>
              <td data-label={t('price')}>{money(supplier.precio)}</td>
              <td data-label={t('freight')}>{money(supplier.flete)}</td>
              <td data-label={t('minimum')}>{supplier.minimo}</td>
              <td data-label={t('delivery')}>
                {t('days', { count: supplier.dias_entrega })}
              </td>
              <td data-label={t('payment')}>
                {supplier.plazo_pago_dias === 0 &&
                supplier.garantia === NO_QUOTE_DATA
                  ? t('noData')
                  : t('days', { count: supplier.plazo_pago_dias })}
              </td>
              <td data-label={t('warranty')}>
                {supplier.garantia === NO_QUOTE_DATA
                  ? t('noData')
                  : supplier.garantia}
              </td>
              <td data-label={t('total')}>{money(supplier.costo_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.cols}>
        <StockFacts
          facts={[
            { label: t('product'), value: detalle.producto },
            { label: t('quantity'), value: detalle.cantidad },
            { label: t('stock'), value: detalle.stock_esperado },
            {
              label: t('rhythm'),
              value: t('perWeek', { count: detalle.ritmo_semanal }),
            },
          ]}
        />
        <div>
          <p className={styles.factsTitle}>{t('mandate')}</p>
          <StockFacts
            facts={[
              { label: t('target'), value: money(mandato.precio_objetivo) },
              { label: t('ceiling'), value: money(mandato.tope) },
              { label: t('quantity'), value: mandato.cantidad },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
