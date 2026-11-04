'use client'

import { useTranslations } from 'next-intl'
import type { StockProposalOf } from '../../../../types'
import { StockFacts, type StockFact } from '../stock-facts'
import { useStockMoney } from '../stock-format'
import styles from '../stock.module.css'

type Generic = StockProposalOf<
  'venta' | 'catalogo' | 'union_catalogo' | 'apuesta'
>

function BetFacts({ proposal }: { proposal: StockProposalOf<'apuesta'> }) {
  const t = useTranslations('metaExperience.stock.generic')
  const { detalle } = proposal
  const money = useStockMoney(detalle.moneda)
  const units = detalle.unidades_semana_previstas
  return (
    <div className={styles.cols}>
      <StockFacts
        facts={[
          { label: t('product'), value: detalle.producto },
          { label: t('daily'), value: money(detalle.presupuesto_diario) },
          { label: t('ceiling'), value: money(detalle.tope) },
          {
            label: t('duration'),
            value: t('days', { count: detalle.duracion_dias }),
          },
        ]}
      />
      <StockFacts
        facts={[
          {
            label: t('forecast'),
            value:
              units === null
                ? t('noForecast')
                : t(`forecastValue.${detalle.fuente_prevision}`, { units }),
          },
          { label: t('balance'), value: detalle.senal.saldo },
          { label: t('expected'), value: detalle.senal.esperado },
        ]}
      />
    </div>
  )
}

/** Venta, catálogo y unión comparten el mismo lenguaje de datos. */
function useSimpleFacts(proposal: Exclude<Generic, { tipo: 'apuesta' }>) {
  const t = useTranslations('metaExperience.stock.generic')
  const facts: StockFact[] = []
  if (proposal.tipo === 'venta') {
    const { producto, cantidad, kit_id } = proposal.detalle
    facts.push(
      { label: t('product'), value: producto },
      { label: t('quantity'), value: cantidad }
    )
    if (kit_id) facts.push({ label: t('kind'), value: t('kitSale') })
  }
  if (proposal.tipo === 'catalogo') {
    const { producto, variantes, oferta } = proposal.detalle
    facts.push(
      { label: t('product'), value: producto },
      { label: t('variants'), value: variantes.join(', ') },
      { label: t('offer'), value: oferta?.nombre ?? t('noOffer') }
    )
  }
  if (proposal.tipo === 'union_catalogo') {
    facts.push({
      label: t('similarity'),
      value: `${Math.round(proposal.detalle.similitud * 100)} %`,
    })
  }
  return facts
}

function SimpleCard({
  proposal,
}: {
  proposal: Exclude<Generic, { tipo: 'apuesta' }>
}) {
  return <StockFacts facts={useSimpleFacts(proposal)} />
}

export function GenericCard({ proposal }: { proposal: Generic }) {
  return proposal.tipo === 'apuesta' ? (
    <BetFacts proposal={proposal} />
  ) : (
    <SimpleCard proposal={proposal} />
  )
}
