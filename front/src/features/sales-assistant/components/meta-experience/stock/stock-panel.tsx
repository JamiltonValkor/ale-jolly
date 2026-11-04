'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import type { StockSummary } from '../../../types'
import { useStockSummary } from '../../../hooks/use-stock'
import { CompanionStage } from '../companion-stage'
import type { CompanionMood, RenderCompanion } from '../types'
import { StockApprovalsView } from './stock-approvals-view'
import { StockCurrentView } from './stock-current-view'
import { StockOrdersView } from './stock-orders-view'
import { StockSectionNotice } from './stock-states'
import { StockSummaryStats } from './stock-summary'
import { StockViewTabs } from './stock-view-tabs'
import { useStockView } from './use-stock-view'
import styles from './stock.module.css'

interface Props {
  businessId: string
  businessName?: string | null
  renderCompanion?: RenderCompanion
}

/** Qué le toca a la dueña ahora, en una frase y con las cifras del servidor. */
function useHeadline(summary: StockSummary | undefined) {
  const t = useTranslations('metaExperience.stock.hero')
  if (!summary) return { body: t('loading'), mood: 'idle' as CompanionMood }
  if (summary.propuestas_pendientes > 0)
    return {
      body: t('pending', { count: summary.propuestas_pendientes }),
      mood: 'listening' as CompanionMood,
    }
  if (summary.diferencias_por_resolver > 0)
    return {
      body: t('differences', { count: summary.diferencias_por_resolver }),
      mood: 'idle' as CompanionMood,
    }
  return { body: t('calm'), mood: 'happy' as CompanionMood }
}

/** Pantalla Stock: Jolly arriba, las cifras y las tres vistas de la dueña. */
export function StockPanel({
  businessId,
  businessName,
  renderCompanion,
}: Props) {
  const t = useTranslations('metaExperience.stock')
  const idPrefix = useId()
  const { view, proposalId, go } = useStockView()
  const summary = useStockSummary(businessId)
  const headline = useHeadline(summary.data)
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <CompanionStage
          size="mini"
          mood={headline.mood}
          label={t('hero.companion')}
          renderCompanion={renderCompanion}
        />
        <div className={styles.heroCopy}>
          <h1 className={styles.title}>
            {businessName
              ? t('hero.title', { business: businessName })
              : t('title')}
          </h1>
          <p className={styles.sub}>{headline.body}</p>
          <p className={styles.rule}>{t('hero.rule')}</p>
        </div>
      </section>
      <StockSummaryStats summary={summary.data} onOpen={next => go(next)} />
      {summary.isError ? (
        <StockSectionNotice
          section="summary"
          onRetry={() => void summary.refetch()}
        />
      ) : null}
      <StockViewTabs
        idPrefix={idPrefix}
        value={view}
        pending={summary.data?.propuestas_pendientes ?? 0}
        onChange={next => go(next)}
      />
      <section
        id={`${idPrefix}-stock-view`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-stock-tab-${view}`}
        className={styles.view}
      >
        {view === 'actual' ? (
          <StockCurrentView
            businessId={businessId}
            onOpenProposal={id => go('por-aprobar', id)}
          />
        ) : null}
        {view === 'por-aprobar' ? (
          <StockApprovalsView
            businessId={businessId}
            currency={summary.data?.moneda ?? 'COP'}
            proposalId={proposalId}
          />
        ) : null}
        {view === 'pedidos' ? (
          <StockOrdersView businessId={businessId} />
        ) : null}
      </section>
    </div>
  )
}
