'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCancelStockOrder } from '../../../hooks/use-stock'
import { isStockGoneError, stockCancelErrorKey } from '../../../lib/stock-error'
import type { StockOrder } from '../../../types'
import { MetaConfirmDialog } from '../meta-confirm-dialog'
import styles from './stock.module.css'

interface Props {
  order: StockOrder
  businessId: string
}

/**
 * Corta una negociación. Dice antes de confirmar que el proveedor no se entera:
 * el servicio no le escribe, y el dueño podría creer que sí. El diálogo sobrevive
 * al refresco: si el pedido cambió de estado, explica por qué ya no se puede.
 */
export function StockOrderCancel({ order, businessId }: Props) {
  const t = useTranslations('metaExperience.stock')
  const cancel = useCancelStockOrder(businessId)
  const [open, setOpen] = useState(false)
  const sending = useRef(false)
  const negotiating = order.estado === 'negociando'
  const gone = !negotiating || isStockGoneError(cancel.error)
  const close = () => {
    cancel.reset()
    setOpen(false)
  }
  const confirm = () => {
    if (sending.current) return
    sending.current = true
    cancel.mutate(order.id, {
      onSuccess: close,
      onSettled: () => {
        sending.current = false
      },
    })
  }
  if (!negotiating && !open) return null
  return (
    <div className={styles.orderNotes}>
      {negotiating ? (
        <button type="button" className="mu-btn" onClick={() => setOpen(true)}>
          {t('orders.cancel')}
        </button>
      ) : null}
      {open ? (
        <MetaConfirmDialog
          open
          onOpenChange={next => {
            if (!next) close()
          }}
          title={t('orders.cancelTitle')}
          description={t('orders.cancelBody', {
            count: order.cantidad,
            product: order.producto,
            supplier: order.proveedor,
          })}
          confirmLabel={t(cancel.isError ? 'dialog.retry' : 'orders.cancel')}
          cancelLabel={t('dialog.back')}
          onConfirm={confirm}
          isPending={cancel.isPending}
          hideConfirm={gone}
        >
          <div className={styles.dialogBody}>
            <p className={styles.limit}>{t('orders.cancelNotice')}</p>
            {cancel.isError || gone ? (
              <p
                role="alert"
                aria-live="assertive"
                className={styles.dialogError}
              >
                {t(
                  gone ? 'errors.cancelGone' : stockCancelErrorKey(cancel.error)
                )}
              </p>
            ) : null}
          </div>
        </MetaConfirmDialog>
      ) : null}
    </div>
  )
}
