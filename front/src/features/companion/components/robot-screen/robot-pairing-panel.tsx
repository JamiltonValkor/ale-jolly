'use client'

import { useTranslations } from 'next-intl'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

import { PAIRING_TIMINGS } from '../../lib/pairing-transport'
import { CompanionFace } from '../face/companion-face'
import { RobotTopbar } from './robot-chrome'
import { RobotQr } from './robot-qr'
import styles from './robot-screen.module.css'

interface Props {
  /** `renewing`: el código venció y viene uno nuevo (sin pedir nada). */
  phase: 'waiting' | 'renewing'
  code: string | null
  qrUrl: string | null
  remainingMs: number | null
  waking?: boolean
  plateColor?: string
}

const EASE = [0.22, 1, 0.36, 1] as const

/** El código entra letra a letra cuando cambia (suave, sin sobresaltos). */
function PairingCode({ code, stale }: { code: string; stale: boolean }) {
  const t = useTranslations('companion.robot.pairing')
  const reduced = useReducedMotion() ?? false
  const chars = code.split('')
  return (
    <div className={styles.codeBlock}>
      <span id="robot-code-label" className={styles.label}>
        {t('codeLabel')}
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={code}
          aria-labelledby="robot-code-label"
          className={cn(styles.code, stale && styles.codeOld)}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={
            reduced
              ? { opacity: 0 }
              : { opacity: 0, filter: 'blur(8px)', y: -10 }
          }
          transition={{ duration: 0.45, ease: EASE }}
        >
          {chars.map((char, i) => (
            <motion.span
              key={`${char}-${i}`}
              className={styles.codeChar}
              initial={
                reduced ? false : { opacity: 0, y: 14, filter: 'blur(6px)' }
              }
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{
                duration: 0.6,
                ease: EASE,
                delay: reduced ? 0 : 0.08 + i * 0.07,
              }}
            >
              {i === 4 ? <span className={styles.codeSep}>·</span> : null}
              {char}
            </motion.span>
          ))}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function Expiry({ remainingMs }: { remainingMs: number }) {
  const t = useTranslations('companion.robot.pairing')
  const minutes = Math.ceil(remainingMs / 60_000)
  const share = Math.min(1, remainingMs / PAIRING_TIMINGS.codeTtlMs)
  return (
    <div className={styles.expiry}>
      <div className={styles.expiryTrack} aria-hidden="true">
        <div
          className={styles.expiryFill}
          style={{ transform: `scaleX(${share})` }}
        />
      </div>
      <span>
        {remainingMs < 60_000 ? t('expiresSoon') : t('expiresIn', { minutes })}
      </span>
    </div>
  )
}

/**
 * «Sincronízame con Saleads»: la cara invita, el código grande se escribe en
 * Saleads y el QR es el atajo desde el celular. Si el código vence, el
 * robot pide otro solo y lo dice con calma.
 */
export function RobotPairingPanel({
  phase,
  code,
  qrUrl,
  remainingMs,
  waking,
  plateColor,
}: Props) {
  const t = useTranslations('companion.robot')
  const renewing = phase === 'renewing'
  return (
    <div className={cn(styles.panel, styles.split, styles.pairing)}>
      <RobotTopbar
        status={renewing ? t('expired.status') : t('pairing.waiting')}
        tone={renewing ? 'warn' : 'live'}
      />
      <div className={styles.faceWrap}>
        <span className={styles.faceHalo} aria-hidden="true" />
        <CompanionFace
          state={renewing ? 'thinking' : waking ? 'waking' : 'idle'}
          plateColor={plateColor}
        />
      </div>
      <div className={styles.copy}>
        <h1 className={styles.title}>
          {renewing ? t('expired.title') : t('pairing.title')}
        </h1>
        {code ? <PairingCode code={code} stale={renewing} /> : null}
        <p className={styles.lead}>
          {renewing ? t('expired.body') : t('pairing.instruction')}
        </p>
        {!renewing && remainingMs !== null ? (
          <Expiry remainingMs={remainingMs} />
        ) : null}
      </div>
      {qrUrl ? (
        <div className={styles.qrColumn}>
          <div className={cn(styles.qrTile, renewing && styles.qrStale)}>
            <RobotQr url={qrUrl} alt={t('pairing.qrAlt')} />
          </div>
          <span>{t('pairing.qrLabel')}</span>
        </div>
      ) : null}
    </div>
  )
}
