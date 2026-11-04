'use client'

import { useTranslations } from 'next-intl'
import type { StockProposalOf } from '../../../../types'
import { StockFacts } from '../stock-facts'
import { useStockMoney } from '../stock-format'
import styles from '../stock.module.css'

interface Props {
  proposal: StockProposalOf<'autonomia'>
  currency: string
}

/** Permiso: la evidencia la pone el servidor. Solo el dueño sube de nivel (R34). */
export function PermissionCard({ proposal, currency }: Props) {
  const t = useTranslations('metaExperience.stock')
  const { detalle } = proposal
  const money = useStockMoney(currency)
  const level = (nivel: number) => t(`levels.${nivel}` as 'levels.1')
  return (
    <div className={styles.stack}>
      <div className={styles.cols}>
        <StockFacts
          facts={[
            {
              label: t('permission.area'),
              value: t(`areas.${detalle.area}`),
            },
            {
              label: t('permission.current'),
              value: level(detalle.nivel_actual),
            },
            {
              label: t('permission.requested'),
              value: level(detalle.nivel_pedido),
            },
            {
              label: t('permission.ceiling'),
              value: money(detalle.monto_tope),
            },
          ]}
        />
        <div>
          <p className={styles.factsTitle}>{t('permission.evidence')}</p>
          <StockFacts
            facts={detalle.evidencia.map(item => ({
              label: item.simulado
                ? t('permission.simulatedFact', { fact: item.dato })
                : item.dato,
              value: item.valor,
            }))}
          />
        </div>
      </div>
      {detalle.nivel_efectivo < detalle.nivel_pedido ? (
        <p className={styles.pmeta}>
          {t('permission.effective', {
            level: level(detalle.nivel_efectivo),
          })}
        </p>
      ) : null}
    </div>
  )
}
