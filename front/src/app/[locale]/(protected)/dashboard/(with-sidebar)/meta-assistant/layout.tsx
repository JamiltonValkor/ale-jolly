import type { ReactNode } from 'react'
import { MetaAssistantChrome } from '@/shared/shells/meta-assistant-chrome'

/** Todo Meta Assistant (y sus aprobaciones) sin el orbe de Ale. */
export default function MetaAssistantLayout({
  children,
}: {
  children: ReactNode
}) {
  return <MetaAssistantChrome>{children}</MetaAssistantChrome>
}
