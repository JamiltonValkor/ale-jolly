import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import {
  plusJakartaSans,
  ubuntuSansMono,
  dancingScript,
  manrope,
} from '@/shared/fonts/google-fonts'
import '@/shared/fonts/google-fonts.css'
import './globals.css'

/** Layout raíz del modo local: fuentes y CSS de SaleADS, sin analítica. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: 'Meta Assistant · Ale + Jolly (local)',
  icons: { icon: '/favicon.png' },
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="es"
      translate="no"
      className={`${plusJakartaSans.variable} ${ubuntuSansMono.variable} ${dancingScript.variable} ${manrope.variable} notranslate`}
      suppressHydrationWarning
    >
      <body className="antialiased">{children}</body>
    </html>
  )
}
