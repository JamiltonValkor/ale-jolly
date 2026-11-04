// TDD-SKIP: configuración declarativa next/font; carga y aislamiento verificados en fixture.
import localFont from 'next/font/local'

/** Next genera familias propias desde agentV2Sans/Mono, sin colisión con fonts.ts. */
export const agentV2Sans = localFont({
  src: '../assets/fonts/dm-sans-v2.woff2',
  variable: '--font-agent-v2-sans',
  weight: '100 1000',
  style: 'normal',
  display: 'swap',
})

export const agentV2Mono = localFont({
  src: '../assets/fonts/jetbrains-mono-v2.woff2',
  variable: '--font-agent-v2-mono',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
})

export const agentV2FontClassName = `${agentV2Sans.variable} ${agentV2Mono.variable}`
