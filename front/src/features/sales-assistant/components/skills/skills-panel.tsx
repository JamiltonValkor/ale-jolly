'use client'

import { BusinessTypeCard } from './business-type-card'
import { SkillsCatalog } from './skills-catalog'

/**
 * Pestaña «Habilidades» de Mi asistente (OSF-004): el tipo de negocio, que
 * elige la estrategia del equipo (MLF-001), y el catálogo. Compartir lecciones
 * ya no se apaga desde aquí (D46/D47, MLF-005).
 */
export function SkillsPanel() {
  return (
    <div className="flex flex-col gap-6">
      <BusinessTypeCard />
      <SkillsCatalog />
    </div>
  )
}
