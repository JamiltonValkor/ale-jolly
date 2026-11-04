'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useLocale } from 'next-intl'

/** Ruta clásica por defecto; Meta Assistant tiene la suya. */
const DEFAULT_APPROVALS_PATH = '/dashboard/assistant/approvals'

const ApprovalsPathContext = createContext(DEFAULT_APPROVALS_PATH)

interface Props {
  /** Sin el prefijo de idioma, p. ej. `/dashboard/meta-assistant/approvals`. */
  basePath: string
  children: ReactNode
}

/** La página decide a qué asistente pertenecen las aprobaciones de su actividad. */
export function AgentApprovalsPathProvider({ basePath, children }: Props) {
  return (
    <ApprovalsPathContext.Provider value={basePath}>
      {children}
    </ApprovalsPathContext.Provider>
  )
}

/** Enlace a una aprobación, con idioma y el asistente correcto. */
export function useAgentApprovalHref(approvalId: string): string {
  const locale = useLocale()
  return `/${locale}${useContext(ApprovalsPathContext)}/${approvalId}`
}
