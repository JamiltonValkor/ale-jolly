'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { humanizeToken } from '../../lib/meta-brain/describe'
import { familyOf } from '../../lib/meta-brain/palette'

/**
 * Las palabras del cerebro en un solo lugar: familia, etapa, confianza y
 * relación, con caída a palabras legibles si el servicio manda un valor
 * nuevo (nunca se muestra `en_prueba` ni `TESTED_IN`).
 */
export function useBrainWords() {
  const t = useTranslations('metaBrain')
  return useMemo(
    () => ({
      family: (family: string) => t(`family.${familyOf(family)}`),
      stage: (stage: string) =>
        t.has(`stages.${stage}`) ? t(`stages.${stage}`) : humanizeToken(stage),
      confidence: (value: string) =>
        t.has(`confidence.${value}`)
          ? t(`confidence.${value}`)
          : humanizeToken(value),
      relation: (type: string) =>
        t.has(`relations.${type}`)
          ? t(`relations.${type}`)
          : humanizeToken(type).toLowerCase(),
    }),
    [t]
  )
}

export type BrainWords = ReturnType<typeof useBrainWords>
