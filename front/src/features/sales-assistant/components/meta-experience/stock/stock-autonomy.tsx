'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ShieldCheck } from '@phosphor-icons/react'
import {
  useChangeStockAutonomy,
  useStockAutonomy,
} from '../../../hooks/use-stock'
import { isStockFinalError, stockLevelErrorKey } from '../../../lib/stock-error'
import { STOCK_MOTIVO_MAX, type StockAutonomyArea } from '../../../types'
import { MetaConfirmDialog } from '../meta-confirm-dialog'
import { StockSectionNotice } from './stock-states'
import styles from './stock.module.css'

const MIN_LEVEL = 1
const MAX_LEVEL = 4

/** Un área en 1 solo puede regresar a 2; las demás solo bajan. */
const nextLevel = ({ nivel }: StockAutonomyArea) =>
  nivel === MIN_LEVEL ? MIN_LEVEL + 1 : nivel - 1

function LevelDialog({
  area,
  businessId,
  onClose,
}: {
  area: StockAutonomyArea
  businessId: string
  onClose: () => void
}) {
  const t = useTranslations('metaExperience.stock')
  const change = useChangeStockAutonomy(businessId)
  const [reason, setReason] = useState('')
  const sending = useRef(false)
  const next = nextLevel(area)
  const raising = next > area.nivel
  const action = t(raising ? 'autonomy.raise' : 'autonomy.lower')
  const confirm = () => {
    if (sending.current) return
    sending.current = true
    change.mutate(
      {
        area: area.area,
        revision: area.revision,
        nivel: next,
        motivo: reason.trim() || undefined,
      },
      {
        onSuccess: onClose,
        onSettled: () => {
          sending.current = false
        },
      }
    )
  }
  return (
    <MetaConfirmDialog
      open
      onOpenChange={open => {
        if (open) return
        change.clearAttempts()
        onClose()
      }}
      title={t(raising ? 'autonomy.raiseTitle' : 'autonomy.lowerTitle')}
      description={t(raising ? 'autonomy.raiseBody' : 'autonomy.lowerBody', {
        area: t(`areas.${area.area}`),
        level: t(`levels.${next}` as 'levels.1'),
      })}
      confirmLabel={change.isError ? t('dialog.retry') : action}
      cancelLabel={t('dialog.back')}
      onConfirm={confirm}
      isPending={change.isPending}
      hideConfirm={isStockFinalError(change.error)}
    >
      <div className={styles.dialogBody}>
        <label className={styles.reason}>
          {t('dialog.reason')}
          <textarea
            rows={2}
            maxLength={STOCK_MOTIVO_MAX}
            value={reason}
            onChange={event => setReason(event.target.value)}
          />
        </label>
        {change.isError ? (
          <p role="alert" aria-live="assertive" className={styles.dialogError}>
            {t(stockLevelErrorKey(change.error))}
          </p>
        ) : null}
      </div>
    </MetaConfirmDialog>
  )
}

/** Niveles por área (R33). Se baja, o se regresa de 1 a 2; más arriba lo pide Jolly con evidencia. */
export function StockAutonomy({ businessId }: { businessId: string }) {
  const t = useTranslations('metaExperience.stock')
  const autonomy = useStockAutonomy(businessId)
  const [area, setArea] = useState<StockAutonomyArea | null>(null)
  const areas = autonomy.data?.areas
  if (autonomy.isError)
    return (
      <StockSectionNotice
        section="autonomy"
        onRetry={() => void autonomy.refetch()}
      />
    )
  if (!areas) return null
  return (
    <section className={`mu-card ${styles.autonomy}`}>
      <div className={styles.cardTop}>
        <span aria-hidden className={styles.kindIcon}>
          <ShieldCheck size={18} weight="light" />
        </span>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('autonomy.title')}</h2>
          <p className={styles.pmeta}>{t('autonomy.body')}</p>
        </div>
      </div>
      <ul className={styles.levels}>
        {areas.map(item => (
          <li key={item.area}>
            <div className={styles.levelName}>
              <span className={styles.pname}>{t(`areas.${item.area}`)}</span>
              <span className={styles.pmeta}>
                {t(`levels.${item.nivel_efectivo}` as 'levels.1')}
              </span>
            </div>
            <span aria-hidden className={styles.meter}>
              {Array.from({ length: MAX_LEVEL }, (_, index) => (
                <i
                  key={index}
                  className={
                    index < item.nivel_efectivo ? styles.meterOn : undefined
                  }
                />
              ))}
            </span>
            <button
              type="button"
              className="mu-btn"
              onClick={() => setArea(item)}
            >
              {t(
                item.nivel === MIN_LEVEL ? 'autonomy.raise' : 'autonomy.lower'
              )}
            </button>
          </li>
        ))}
      </ul>
      {area ? (
        <LevelDialog
          key={`${area.area}:${area.revision}`}
          area={area}
          businessId={businessId}
          onClose={() => setArea(null)}
        />
      ) : null}
    </section>
  )
}
