import { create } from 'zustand'

interface BreadcrumbOverride {
  segment: string
  label: string
  disableLink?: boolean
}

interface BreadcrumbExtension {
  label: string
  href?: string
}

interface BreadcrumbStore {
  // Overrides - para reemplazar labels de segmentos (e.g., ID -> nombre)
  overrides: BreadcrumbOverride[]
  setOverride: (segment: string, label: string, disableLink?: boolean) => void
  clearOverride: (segment: string) => void
  getLabel: (segment: string) => string | null

  // Extensions - para agregar items extra al breadcrumb
  extensions: BreadcrumbExtension[]
  setExtensions: (extensions: BreadcrumbExtension[]) => void
  clearExtensions: () => void

  // Clear all
  clearAll: () => void
}

/**
 * Store para sobrescribir labels de breadcrumbs en rutas dinámicas.
 * Permite que páginas como /campaigns/[id] muestren el nombre
 * de la campaña en lugar del ID.
 *
 * También permite agregar items extra al breadcrumb (extensions)
 * para contexto adicional como pasos de wizard.
 */
export const useBreadcrumbStore = create<BreadcrumbStore>((set, get) => ({
  // Overrides
  overrides: [],

  setOverride: (segment, label, disableLink) => {
    set(state => {
      const existing = state.overrides.find(o => o.segment === segment)
      if (existing) {
        return {
          overrides: state.overrides.map(o =>
            o.segment === segment ? { ...o, label, disableLink } : o
          ),
        }
      }
      return {
        overrides: [...state.overrides, { segment, label, disableLink }],
      }
    })
  },

  clearOverride: segment => {
    set(state => ({
      overrides: state.overrides.filter(o => o.segment !== segment),
    }))
  },

  getLabel: segment => {
    const override = get().overrides.find(o => o.segment === segment)
    return override?.label ?? null
  },

  // Extensions
  extensions: [],

  setExtensions: extensions => set({ extensions }),

  clearExtensions: () => set({ extensions: [] }),

  // Clear all
  clearAll: () => set({ overrides: [], extensions: [] }),
}))
