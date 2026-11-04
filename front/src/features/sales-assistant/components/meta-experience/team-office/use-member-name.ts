'use client'

import { useTranslations } from 'next-intl'
import type { TeamRole } from '../../../lib/meta-experience/team-model'
import { useMetaTeamName } from '../../../store/use-meta-team-names-store'

/** El nombre que le puso la dueña, o el de fábrica. */
export function useMemberName(businessId: string, role: TeamRole): string {
  const t = useTranslations('metaExperience.office.roles')
  return useMetaTeamName(businessId, role) ?? t(`${role}.name`)
}
