'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import QRCode from 'qrcode'

/** El QR de vinculación de WhatsApp que manda Ale, dibujado en el navegador (sin subir imágenes). */
export function ChatWhatsAppQr({ payload }: { payload: string }) {
  const t = useTranslations('salesAssistant.chat')
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(payload, {
      margin: 2,
      width: 264,
      errorCorrectionLevel: 'L',
    })
      .then(url => alive && setSrc(url))
      .catch(() => alive && setSrc(null))
    return () => {
      alive = false
    }
  }, [payload])
  return (
    <figure className="flex flex-col items-start gap-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- data URL generado aquí, sin red
        <img
          src={src}
          width={264}
          height={264}
          alt={t('whatsappQrAlt')}
          className="rounded-lg bg-white p-2"
        />
      ) : (
        <div
          className="bg-sa-surface-elevated h-[264px] w-[264px] animate-pulse rounded-lg"
          aria-hidden
        />
      )}
      <figcaption className="text-sa-text-tertiary text-xs">
        {t('whatsappQrHint')}
      </figcaption>
    </figure>
  )
}
