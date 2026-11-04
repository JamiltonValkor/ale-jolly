'use client'

import Image from 'next/image'
import { useFormatter, useTranslations } from 'next-intl'
import type { StockProposalOf } from '../../../../types'
import { StockFacts } from '../stock-facts'
import type { useStockPhoto } from '../use-stock-photo'
import styles from '../stock.module.css'

interface Props {
  proposal: StockProposalOf<'conteo'>
  photo: ReturnType<typeof useStockPhoto>
}

function Photo({ proposal, photo }: Props) {
  const t = useTranslations('metaExperience.stock.count')
  const format = useFormatter()
  const { foto_url, foto_tomada_en, total_objetos } = proposal.detalle
  if (!foto_url || photo.stale)
    return (
      <p className={styles.photoNote} role="status">
        {t('photoRefreshing')}
      </p>
    )
  // Fecha y total pueden faltar: no se inventa un «0 objetos».
  const when = foto_tomada_en
    ? format.dateTime(new Date(foto_tomada_en), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null
  const caption = [
    when ? t('photoWhen', { when }) : t('photoBy'),
    total_objetos === null ? null : t('photoTotal', { total: total_objetos }),
  ]
  return (
    <figure className={styles.photo}>
      <Image
        src={foto_url}
        alt={
          total_objetos === null
            ? t('photoAltNoTotal')
            : t('photoAlt', { total: total_objetos })
        }
        width={520}
        height={300}
        unoptimized
        onLoad={photo.onLoad}
        onError={photo.onError}
      />
      <figcaption>{caption.filter(Boolean).join(' · ')}</figcaption>
    </figure>
  )
}

function PhotoSlot({ proposal, photo }: Props) {
  const t = useTranslations('metaExperience.stock.count')
  const { foto_estado, origen } = proposal.detalle
  if (foto_estado === 'disponible')
    return <Photo proposal={proposal} photo={photo} />
  if (foto_estado === 'no_disponible')
    return <p className={styles.photoNote}>{t('photoLost')}</p>
  return (
    <p className={styles.photoNote}>
      {t(origen === 'voz' ? 'noPhotoVoice' : 'noPhotoChannel')}
    </p>
  )
}

/** Conteo: foto numerada con total (R13), diferencia y variante dudosa (R15). */
export function CountCard({ proposal, photo }: Props) {
  const t = useTranslations('metaExperience.stock.count')
  const { detalle } = proposal
  const signed =
    detalle.diferencia > 0 ? `+${detalle.diferencia}` : detalle.diferencia
  return (
    <>
      <div className={styles.cols}>
        <PhotoSlot proposal={proposal} photo={photo} />
        <StockFacts
          facts={[
            { label: t('product'), value: detalle.producto },
            { label: t('expected'), value: detalle.esperado },
            { label: t('counted'), value: detalle.contado },
            { label: t('difference'), value: signed, total: true },
          ]}
        />
      </div>
      {detalle.variante_dudosa ? (
        <p className={styles.doubt}>
          <strong>{t('doubt')}</strong> {detalle.variante_dudosa}
        </p>
      ) : null}
    </>
  )
}
