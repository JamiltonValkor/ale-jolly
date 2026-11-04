'use client'

import { useTranslations } from 'next-intl'
import { useStockItems } from '../../../hooks/use-stock'
import type { StockItem, StockItems } from '../../../types'
import { StockKits } from './stock-kits'
import {
  StockEmpty,
  StockLoading,
  StockReadError,
  StockSectionNotice,
} from './stock-states'
import styles from './stock.module.css'

const STATE_CLASS: Record<StockItem['estado'], string> = {
  cuadra: styles.ok,
  causa_preguntada: styles.aviso,
  conteo_por_aprobar: styles.violeta,
  sin_conteo_reciente: styles.mute,
}

/** Junta las variantes de un producto sin cambiar el orden del servidor. */
export function groupVariants(items: StockItem[]): StockItem[] {
  const groups = new Map<string, StockItem[]>()
  for (const item of items) {
    const group = groups.get(item.producto_id)
    if (group) group.push(item)
    else groups.set(item.producto_id, [item])
  }
  return [...groups.values()].flat()
}

const signed = (value: number) => (value > 0 ? `+${value}` : String(value))

function ItemRow({
  item,
  onOpenProposal,
}: {
  item: StockItem
  onOpenProposal: (id: string) => void
}) {
  const t = useTranslations('metaExperience.stock.current')
  const empty = t('noCount')
  const state = t(`states.${item.estado}`)
  const proposal = item.propuesta_id
  const difference = item.diferencia
  return (
    <tr>
      <td>
        <span className={styles.pname}>
          {item.producto}
          <span className={styles.variant}>{item.variante}</span>
          {item.simulado ? (
            <span className="mu-chip">{t('simulated')}</span>
          ) : null}
        </span>
        <span className={styles.pmeta}>
          {item.oferta
            ? t('offer', { name: item.oferta.nombre })
            : t('noOffer')}
        </span>
        <span className={`${styles.pmeta} ${styles.formula}`}>
          {t('formula', {
            last: item.ultimo_conteo ?? empty,
            entries: item.entradas,
            sales: item.ventas_reportadas,
          })}
        </span>
      </td>
      <td data-label={t('columns.expected')}>{item.esperado}</td>
      <td data-label={t('columns.counted')}>
        {item.contado ?? <span className={styles.mute}>{empty}</span>}
      </td>
      <td data-label={t('columns.difference')}>
        {difference === null ? (
          <span className={styles.mute}>{empty}</span>
        ) : (
          <span className={difference < 0 ? styles.aviso : undefined}>
            {signed(difference)}
          </span>
        )}
      </td>
      <td className={styles.stateCell}>
        <span className={`${styles.state} ${STATE_CLASS[item.estado]}`}>
          <span className="mu-dot" aria-hidden />
          {proposal ? (
            <button
              type="button"
              className={styles.link}
              onClick={() => onOpenProposal(proposal)}
            >
              {state}
            </button>
          ) : (
            state
          )}
        </span>
      </td>
    </tr>
  )
}

function ItemsTable({
  data,
  onOpenProposal,
}: {
  data: StockItems
  onOpenProposal: (id: string) => void
}) {
  const t = useTranslations('metaExperience.stock.current')
  return (
    <>
      <div className={`mu-card ${styles.itemsCard}`}>
        <table className={`${styles.table} ${styles.rows}`}>
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('columns.product')}</th>
              <th scope="col">{t('columns.expected')}</th>
              <th scope="col">{t('columns.counted')}</th>
              <th scope="col">{t('columns.difference')}</th>
              <th scope="col" className={styles.stateCell}>
                {t('columns.state')}
              </th>
            </tr>
          </thead>
          <tbody>
            {groupVariants(data.items).map(item => (
              <ItemRow
                key={item.variante_id}
                item={item}
                onOpenProposal={onOpenProposal}
              />
            ))}
          </tbody>
        </table>
      </div>
      <StockKits kits={data.kits} />
      <p className={styles.note}>{t('note')}</p>
    </>
  )
}

interface Props {
  businessId: string
  onOpenProposal: (id: string) => void
}

/** Solo lectura: aquí no se edita stock. Refresca cada 20 s y al volver el foco. */
export function StockCurrentView({ businessId, onOpenProposal }: Props) {
  const items = useStockItems(businessId)
  const retry = () => void items.refetch()
  if (items.isPending) return <StockLoading />
  if (!items.data) return <StockReadError onRetry={retry} />
  const empty = items.data.items.length === 0 && items.data.kits.length === 0
  return (
    <>
      {items.isError ? (
        <StockSectionNotice section="items" onRetry={retry} />
      ) : null}
      {empty ? (
        <StockEmpty kind="items" />
      ) : (
        <ItemsTable data={items.data} onOpenProposal={onOpenProposal} />
      )}
    </>
  )
}
