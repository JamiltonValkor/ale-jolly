'use client'

import { useTranslations } from 'next-intl'
import type { StockProposalOf } from '../../../../types'
import { StockFacts } from '../stock-facts'
import { useStockMoney } from '../stock-format'
import styles from '../stock.module.css'

interface Props {
  proposal: StockProposalOf<'kit'>
}

type Detail = Props['proposal']['detalle']
type Source = NonNullable<Detail['fuentes']>[number]

/** La URL la escribe el agente: solo es enlace si es web de verdad. */
function sourceLink(url: string) {
  if (!URL.canParse(url)) return null
  const { protocol, href, hostname } = new URL(url)
  return protocol === 'https:' || protocol === 'http:'
    ? { href, hostname }
    : null
}

function SourceItem({ source }: { source: Source }) {
  const link = sourceLink(source.url)
  return (
    <li>
      {link ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer nofollow">
          {link.hostname}
        </a>
      ) : (
        source.url
      )}{' '}
      · {source.fecha}
    </li>
  )
}

/** Con qué se armó la propuesta: lo que es supuesto se lee como supuesto. */
function KitBasis({ detalle }: { detalle: Detail }) {
  const t = useTranslations('metaExperience.stock.kit')
  const { diagnostico, precio_fuente: priceSource, fuentes } = detalle
  return (
    <div className={styles.stack}>
      <p className={styles.factsTitle}>{t('basis')}</p>
      <p className={styles.pmeta}>
        {t('hypothesis')} {detalle.hipotesis}
      </p>
      {diagnostico ? (
        <p className={styles.pmeta}>
          {t('diagnosis')} {diagnostico}
        </p>
      ) : null}
      {priceSource ? (
        <p className={styles.pmeta}>
          {t('priceSource')} {priceSource}
        </p>
      ) : null}
      {fuentes === undefined ? (
        <p className={styles.pmeta}>{t('sourcesInChat')}</p>
      ) : fuentes.length === 0 ? (
        <p className={styles.doubt}>{t('noSources')}</p>
      ) : (
        <ul className={styles.pmeta}>
          {fuentes.map(source => (
            <SourceItem key={source.url} source={source} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** Kit: margen y unidades tal como llegan (R20d). Lo que falta se dice. */
export function KitCard({ proposal }: Props) {
  const t = useTranslations('metaExperience.stock.kit')
  const { detalle } = proposal
  const money = useStockMoney(detalle.moneda)
  const pending = t('pending')
  const margin =
    detalle.margen_dinero !== null && detalle.margen_pct !== null
      ? `${money(detalle.margen_dinero)} · ${detalle.margen_pct} %`
      : pending
  return (
    <div className={styles.stack}>
      <div className={styles.cols}>
        <StockFacts
          facts={[
            ...detalle.componentes.map(part => ({
              label: t('component', {
                count: part.cantidad,
                name: part.nombre,
              }),
              value: part.costo === null ? pending : money(part.costo),
            })),
            {
              label: t('cost'),
              value:
                detalle.costo_total === null
                  ? pending
                  : money(detalle.costo_total),
              total: true,
            },
          ]}
        />
        <StockFacts
          facts={[
            { label: t('kind'), value: t(`subtypes.${detalle.subtipo}`) },
            {
              label: t('price'),
              value:
                detalle.precio_propuesto === null
                  ? pending
                  : money(detalle.precio_propuesto),
            },
            { label: t('margin'), value: margin },
            {
              label: t('reach'),
              value: t(detalle.subtipo === 'kit' ? 'kits' : 'units', {
                count: detalle.unidades_alcanzan,
              }),
            },
          ]}
        />
      </div>
      {detalle.costo_incompleto ? (
        <p className={styles.doubt}>{t('incompleteCost')}</p>
      ) : null}
      {detalle.precio_pendiente ? (
        <p className={styles.doubt}>{t('pendingPrice')}</p>
      ) : null}
      <KitBasis detalle={detalle} />
    </div>
  )
}
