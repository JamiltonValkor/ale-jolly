'use client'

import { useTranslations } from 'next-intl'
import type { StockProposalOf } from '../../../../types'
import { useStockMoney } from '../stock-format'
import { splitEntryLine } from '../stock-proposal-rules'
import styles from '../stock.module.css'

interface Props {
  proposal: StockProposalOf<'entrada'>
}

/** Campos que puede traer `dudoso`. Otro valor se nombra sin mostrarlo crudo. */
const DOUBT_LABEL: Record<string, string> = {
  cantidad: 'quantity',
  costo_unitario: 'unitCost',
  descripcion: 'description',
  total: 'total',
  moneda: 'currency',
  'proveedor.nombre': 'supplierName',
  fecha: 'date',
  general: 'general',
}

/** Factura: destino por línea y datos dudosos resaltados (R9). Corregir es rechazar y rehacer (O-15). */
export function ReceiptCard({ proposal }: Props) {
  const t = useTranslations('metaExperience.stock.receipt')
  const { detalle } = proposal
  const money = useStockMoney(detalle.moneda)
  const hasDoubts = detalle.lineas.some(line => line.dudoso.length > 0)
  const mark = (doubtful: boolean) => (doubtful ? styles.aviso : undefined)
  const doubtLabel = (field: string) =>
    t(`fields.${DOUBT_LABEL[field] ?? 'other'}` as 'fields.other')
  return (
    <div className={styles.stack}>
      <p className={styles.pmeta}>
        {detalle.proveedor
          ? t('supplier', { name: detalle.proveedor })
          : t('noSupplier')}
      </p>
      <table className={styles.table}>
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('product')}</th>
            <th scope="col">{t('destination')}</th>
            <th scope="col">{t('quantity')}</th>
            <th scope="col">{t('unitCost')}</th>
          </tr>
        </thead>
        <tbody>
          {detalle.lineas.map((line, index) => {
            const { name, destination, entersStock } = splitEntryLine(
              line.descripcion
            )
            return (
              <tr key={`${index}:${line.descripcion}`}>
                <td>
                  <span className={styles.pname}>{name}</span>
                  {line.dudoso.length > 0 ? (
                    <span className={`${styles.pmeta} ${styles.aviso}`}>
                      {t('confirm', {
                        fields: [...new Set(line.dudoso.map(doubtLabel))].join(
                          ', '
                        ),
                      })}
                    </span>
                  ) : null}
                </td>
                <td data-label={t('destination')}>
                  <span className={mark(!entersStock)}>
                    {entersStock
                      ? (destination ?? t('noDestination'))
                      : t('notInStock')}
                  </span>
                </td>
                <td data-label={t('quantity')}>
                  <span className={mark(line.dudoso.includes('cantidad'))}>
                    {line.cantidad}
                  </span>
                </td>
                <td data-label={t('unitCost')}>
                  <span
                    className={mark(line.dudoso.includes('costo_unitario'))}
                  >
                    {money(line.costo_unitario)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {hasDoubts ? <p className={styles.doubt}>{t('fixHint')}</p> : null}
    </div>
  )
}
