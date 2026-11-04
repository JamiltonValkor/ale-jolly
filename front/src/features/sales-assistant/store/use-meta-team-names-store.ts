/**
 * Estado de UI: el nombre que la dueña le pone a cada agente de la oficina.
 * Vive en este navegador, por negocio, mientras llega su lugar en el servidor.
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const META_TEAM_NAMES_STORAGE_KEY = 'sa-meta-team-names'
export const META_TEAM_NAME_MAX = 24

type Names = Record<string, Record<string, string>>

/** Navegación privada o almacenamiento lleno: el nombre queda en memoria. */
const safeStorage = createJSONStorage(() => ({
  getItem: key => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Sin almacenamiento el nombre dura hasta recargar.
    }
  },
  removeItem: key => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Igual que arriba.
    }
  },
}))

interface MetaTeamNamesState {
  names: Names
  rename: (businessId: string, role: string, name: string) => void
  reset: (businessId: string, role: string) => void
}

function without(names: Names, businessId: string, role: string): Names {
  const rest = { ...names[businessId] }
  delete rest[role]
  return { ...names, [businessId]: rest }
}

export const useMetaTeamNamesStore = create<MetaTeamNamesState>()(
  persist(
    set => ({
      names: {},
      rename: (businessId, role, name) => {
        const clean = name.trim().slice(0, META_TEAM_NAME_MAX)
        if (!businessId) return
        set(state =>
          clean
            ? {
                names: {
                  ...state.names,
                  [businessId]: { ...state.names[businessId], [role]: clean },
                },
              }
            : { names: without(state.names, businessId, role) }
        )
      },
      reset: (businessId, role) =>
        set(state => ({ names: without(state.names, businessId, role) })),
    }),
    {
      name: META_TEAM_NAMES_STORAGE_KEY,
      storage: safeStorage,
      partialize: state => ({ names: state.names }),
    }
  )
)

/** Nombre guardado o `null` (el de fábrica lo pone la UI con i18n). */
export function useMetaTeamName(businessId: string, role: string) {
  return useMetaTeamNamesStore(state => state.names[businessId]?.[role] ?? null)
}
