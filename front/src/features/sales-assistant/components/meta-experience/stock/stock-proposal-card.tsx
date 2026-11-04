'use client'

import { forwardRef, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  Camera,
  GitMerge,
  Megaphone,
  Package,
  Receipt,
  ShieldCheck,
  ShoppingBag,
  Sparkle,
  Tag,
  Truck,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import type { StockDecision, StockProposal } from '../../../types'
import { CountCard } from './cards/count-card'
import { GenericCard } from './cards/generic-card'
import { KitCard } from './cards/kit-card'
import { OrderCard } from './cards/order-card'
import { PermissionCard } from './cards/permission-card'
import { ReceiptCard } from './cards/receipt-card'
import { approvalBlock, confirmKind } from './stock-proposal-rules'
import { useStockPhoto } from './use-stock-photo'
import styles from './stock.module.css'

const KIND_ICON: Record<StockProposal['tipo'], Icon> = {
  conteo: Camera,
  entrada: Receipt,
  venta: ShoppingBag,
  catalogo: Tag,
  union_catalogo: GitMerge,
  pedido: Truck,
  kit: Package,
  apuesta: Megaphone,
  autonomia: ShieldCheck,
  no_soportada: Sparkle,
}

interface Props {
  proposal: StockProposal
  currency: string
  /** Propuesta ya decidida en esta sesión: se muestra su resultado. */
  resolved?: boolean
  onDecide: (proposal: StockProposal, decision: StockDecision) => void
  onRefresh: () => void
}

function detailOf(
  proposal: StockProposal,
  currency: string,
  photo: ReturnType<typeof useStockPhoto>
): ReactNode {
  switch (proposal.tipo) {
    case 'conteo':
      return <CountCard proposal={proposal} photo={photo} />
    case 'pedido':
      return <OrderCard proposal={proposal} />
    case 'kit':
      return <KitCard proposal={proposal} />
    case 'entrada':
      return <ReceiptCard proposal={proposal} />
    case 'autonomia':
      return <PermissionCard proposal={proposal} currency={currency} />
    case 'no_soportada':
      return null
    default:
      return <GenericCard proposal={proposal} />
  }
}

/** Una propuesta: qué es, por qué, sus datos y aprobar o rechazar. */
export const StockProposalCard = forwardRef<HTMLElement, Props>(
  function StockProposalCard(
    { proposal, currency, resolved = false, onDecide, onRefresh },
    ref
  ) {
    const t = useTranslations('metaExperience.stock')
    const isCount = proposal.tipo === 'conteo'
    const photo = useStockPhoto(
      isCount ? proposal.detalle.foto_url : null,
      isCount ? proposal.detalle.foto_expira_en : null,
      onRefresh
    )
    const block = approvalBlock(proposal, photo.ready)
    const KindIcon = KIND_ICON[proposal.tipo]
    return (
      <article
        ref={ref}
        tabIndex={-1}
        data-proposal={proposal.id}
        className={cn('mu-card', styles.card, resolved && styles.cardDone)}
      >
        <div className={styles.cardTop}>
          <span aria-hidden className={styles.kindIcon}>
            <KindIcon size={18} weight="light" />
          </span>
          <div className={styles.cardHead}>
            <span className={cn('mu-label', styles.kind)}>
              {proposal.tipo === 'kit'
                ? t(`kit.subtypes.${proposal.detalle.subtipo}`)
                : t(`kinds.${proposal.tipo}`)}
            </span>
            <h2 className={styles.cardTitle}>{proposal.titulo}</h2>
          </div>
          <span className="mu-chip">
            {t(proposal.simulado ? 'tagSimulated' : 'tagReal')}
          </span>
        </div>
        <p className={styles.why}>{proposal.motivo}</p>
        {detailOf(proposal, currency, photo)}
        {resolved ? (
          <p className={styles.done} role="status">
            <span className="mu-dot" aria-hidden />
            {t(proposal.estado === 'aprobada' ? 'approved' : 'rejected')}
          </p>
        ) : (
          <>
            {block ? (
              <p className={styles.blocked}>{t(`blocks.${block}`)}</p>
            ) : null}
            <div className={styles.actions}>
              <button
                type="button"
                className="mu-btn mu-btn-ghost"
                onClick={() => onDecide(proposal, 'reject')}
              >
                {t('reject')}
              </button>
              <button
                type="button"
                className="mu-btn mu-btn-p"
                disabled={block !== null}
                onClick={() => onDecide(proposal, 'approve')}
              >
                {t(`confirm.${confirmKind(proposal)}`)}
              </button>
            </div>
          </>
        )}
      </article>
    )
  }
)
