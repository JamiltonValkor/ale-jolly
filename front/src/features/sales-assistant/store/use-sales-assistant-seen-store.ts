/**
 * Estado de UI: último «listo» que cada usuario vio al abrir «Mi asistente».
 * Persistido por `userId` para que el indicador no reaparezca al recargar ni
 * se mezcle entre cuentas del mismo navegador. Sin fetch: el estado del
 * asistente vive en React Query (useSalesAssistantMe).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const SALES_ASSISTANT_SEEN_STORAGE_KEY = 'sa-sales-assistant-seen'

export function seenUserKey(
  userId: string,
  namespace = 'sales-assistant'
): string {
  return namespace === 'sales-assistant' ? userId : `${namespace}:${userId}`
}

interface SalesAssistantSeenState {
  lastSeenByUser: Record<string, string>
}

interface SalesAssistantSeenActions {
  markSeen: (userId: string, readySince: string, namespace?: string) => void
}

export const useSalesAssistantSeenStore = create<
  SalesAssistantSeenState & SalesAssistantSeenActions
>()(
  persist(
    set => ({
      lastSeenByUser: {},
      markSeen: (userId, readySince, namespace = 'sales-assistant') => {
        const key = seenUserKey(userId, namespace)
        if (!userId || !readySince) return
        set(state =>
          state.lastSeenByUser[key] === readySince
            ? state
            : {
                lastSeenByUser: {
                  ...state.lastSeenByUser,
                  [key]: readySince,
                },
              }
        )
      },
    }),
    {
      name: SALES_ASSISTANT_SEEN_STORAGE_KEY,
      partialize: state => ({ lastSeenByUser: state.lastSeenByUser }),
    }
  )
)
