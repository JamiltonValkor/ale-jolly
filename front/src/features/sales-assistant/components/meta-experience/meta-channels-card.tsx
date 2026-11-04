'use client'

import { useId, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  ChatsCircle,
  InstagramLogo,
  Robot,
  WhatsappLogo,
  type Icon,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import styles from './meta-today.module.css'

export interface CompanionLink {
  paired: boolean
  deviceName: string | null
}

interface Props {
  companion: CompanionLink | null
  onPairCompanion: () => void
  /** Vincular un canal se hace conversando: abre el chat con el pedido escrito. */
  onLinkChannel: (prompt: string) => void
  /** En pausa no se vinculan canales; sincronizar el compañero sigue activo. */
  stopped?: boolean
  className?: string
}

function Row({
  icon: RowIcon,
  name,
  body,
  end,
}: {
  icon: Icon
  name: string
  body: string
  end: ReactNode
}) {
  return (
    <li className="mu-row">
      <span className="mu-tile" aria-hidden>
        <RowIcon size={17} weight="light" />
      </span>
      <div>
        <p className={styles.rowTitle}>{name}</p>
        <p className={styles.rowBody}>{body}</p>
      </div>
      <span className={styles.rowEnd}>{end}</span>
    </li>
  )
}

/** «Dónde vive tu asistente»: el mismo asistente en cada canal, y el compañero físico. */
export function MetaChannelsCard({
  companion,
  onPairCompanion,
  onLinkChannel,
  stopped,
  className,
}: Props) {
  const t = useTranslations('metaExperience.channels')
  const tStatus = useTranslations('metaExperience.header.status')
  const titleId = useId()
  const active = (
    <span className="mu-chip">
      <span aria-hidden className={cn('mu-dot', styles.nowDot)} />
      {t('active')}
    </span>
  )
  return (
    <section className={cn('mu-card', className)} aria-labelledby={titleId}>
      <div className="mu-head">
        <h3 id={titleId} className={styles.headTitle}>
          {t('title')}
        </h3>
      </div>
      <ul>
        <Row
          icon={ChatsCircle}
          name={t('saleads.name')}
          body={t('saleads.body')}
          end={
            stopped ? (
              <span className="mu-chip">{tStatus('stopped')}</span>
            ) : (
              active
            )
          }
        />
        <Row
          icon={Robot}
          name={t('companion.name')}
          body={
            companion?.paired && companion.deviceName
              ? t('companion.paired', { device: companion.deviceName })
              : t('companion.body')
          }
          end={
            companion?.paired ? (
              active
            ) : (
              <button
                type="button"
                className="mu-btn mu-btn-p"
                onClick={onPairCompanion}
              >
                {t('companion.action')}
              </button>
            )
          }
        />
        <Row
          icon={WhatsappLogo}
          name={t('whatsapp.name')}
          body={t('whatsapp.body')}
          end={
            <button
              type="button"
              className="mu-btn"
              onClick={() => onLinkChannel(t('whatsapp.prompt'))}
              aria-disabled={stopped || undefined}
            >
              {t('whatsapp.action')}
            </button>
          }
        />
        <Row
          icon={InstagramLogo}
          name={t('instagram.name')}
          body={t('instagram.body')}
          end={
            <button
              type="button"
              className="mu-btn"
              onClick={() => onLinkChannel(t('instagram.prompt'))}
              aria-disabled={stopped || undefined}
            >
              {t('instagram.action')}
            </button>
          }
        />
      </ul>
    </section>
  )
}
