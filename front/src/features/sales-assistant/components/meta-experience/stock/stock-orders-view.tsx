'use client'

import { useTranslations } from 'next-intl'
import { Truck } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { useStockOrders } from '../../../hooks/use-stock'
import type { StockOrder } from '../../../types'
import { useStockMoney } from './stock-format'
import { StockOrderCancel } from './stock-order-cancel'
import {
  StockEmpty,
  StockLoading,
  StockReadError,
  StockSectionNotice,
} from './stock-states'
import styles from './stock.module.css'

const STEPS = [
  'aprobado',
  'negociando',
  'acordado',
  'en_camino',
  'recibido',
] as const

const TONE: Partial<Record<StockOrder['estado'], string>> = {
  recibido: styles.ok,
  cancelado: styles.mute,
}

/** `en_camino` aún no se emite: la línea pasa de acordado a recibido sin hueco. */
function Track({ order }: { order: StockOrder }) {
  const t = useTranslations('metaExperience.stock.orders')
  const step = STEPS.indexOf(order.estado as (typeof STEPS)[number])
  if (step < 0) return null
  return (
    <ol
      className={styles.track}
      aria-label={t('progress', {
        step: step + 1,
        total: STEPS.length,
        state: t(`states.${order.estado}`),
      })}
    >
      {STEPS.map((name, index) => (
        <li
          key={name}
          className={
            index === step ? styles.now : index < step ? styles.on : undefined
          }
          aria-current={index === step ? 'step' : undefined}
        >
          {t(`states.${name}`)}
        </li>
      ))}
    </ol>
  )
}

/** R31 y R32: ahorro solo con recepción confirmada, y pedido contra recibido. */
function OrderNotes({ order }: { order: StockOrder }) {
  const t = useTranslations('metaExperience.stock.orders')
  const money = useStockMoney(order.moneda)
  const received = order.recibido_cantidad
  const short = received !== null && received !== order.pedido_cantidad
  const saving = order.estado === 'recibido' ? order.ahorro_confirmado : null
  const noPayment = order.estado === 'negociando' || order.estado === 'acordado'
  return (
    <div className={styles.orderNotes}>
      {order.novedad ? (
        <p className={styles.aviso}>{t('supplierReplied')}</p>
      ) : null}
      {received !== null ? (
        <p className={short ? styles.mal : undefined}>
          {t(short ? 'receivedShort' : 'receivedFull', {
            received,
            ordered: order.pedido_cantidad,
          })}
        </p>
      ) : null}
      {saving !== null ? (
        <p className={styles.ok}>{t('saving', { amount: money(saving) })}</p>
      ) : null}
      {noPayment ? <p>{t('noPayment')}</p> : null}
    </div>
  )
}

function OrderRow({
  order,
  businessId,
}: {
  order: StockOrder
  businessId: string
}) {
  const t = useTranslations('metaExperience.stock.orders')
  const money = useStockMoney(order.moneda)
  const cost = order.costo
    ? t(`cost.${order.costo_tipo}`, { amount: money(order.costo) })
    : t('noCost')
  return (
    <article className={cn('mu-card', styles.order)}>
      <span aria-hidden className={styles.kindIcon}>
        <Truck size={18} weight="light" />
      </span>
      <div className="min-w-0">
        <span className={styles.pname}>
          {t('title', { count: order.cantidad, product: order.producto })}
          {order.simulado ? (
            <span className="mu-chip">{t('simulated')}</span>
          ) : null}
        </span>
        <span className={styles.pmeta}>
          {order.proveedor} · {cost}
        </span>
      </div>
      <span
        className={cn(
          styles.state,
          styles.pill,
          TONE[order.estado] ?? styles.aviso
        )}
      >
        <span className="mu-dot" aria-hidden />
        {t(`states.${order.estado}`)}
      </span>
      <OrderNotes order={order} />
      <Track order={order} />
      <StockOrderCancel order={order} businessId={businessId} />
    </article>
  )
}

/** Refresca cada 20 s solo mientras haya un pedido en curso y esta vista esté abierta. */
export function StockOrdersView({ businessId }: { businessId: string }) {
  const t = useTranslations('metaExperience.stock.orders')
  const orders = useStockOrders(businessId)
  const retry = () => void orders.refetch()
  if (orders.isPending) return <StockLoading />
  if (!orders.data) return <StockReadError onRetry={retry} />
  const notice = orders.isError ? (
    <StockSectionNotice section="orders" onRetry={retry} />
  ) : null
  if (orders.data.pedidos.length === 0)
    return (
      <>
        {notice}
        <StockEmpty kind="orders" />
      </>
    )
  return (
    <>
      {notice}
      <div className={styles.cards}>
        {orders.data.pedidos.map(order => (
          <OrderRow key={order.id} order={order} businessId={businessId} />
        ))}
      </div>
      <p className={styles.note}>{t('note')}</p>
    </>
  )
}
