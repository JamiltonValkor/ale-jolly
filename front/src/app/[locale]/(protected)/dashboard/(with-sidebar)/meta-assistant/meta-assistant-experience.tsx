'use client'

import {
  AgentActivityFeed,
  AgentApprovalsPathProvider,
  AgentLimitsCompact,
  AgentPendingApprovals,
} from '@/features/autonomous-team'
import {
  MetaActivityEmpty,
  MetaBrainView,
  MetaExperience,
} from '@/features/sales-assistant'
import {
  renderMetaCompanion,
  renderMetaFace,
  renderMetaPairing,
  useMetaCompanionLink,
} from '@/shared/shells/meta-companion'
import { renderMetaComposer } from '@/shared/shells/meta-chat-composer'

/**
 * Composición de Meta Assistant (capa app: las features no se importan entre
 * sí). Aquí se juntan el asistente, su cerebro, los límites y la actividad del
 * equipo autónomo, el compañero 3D, su cara, la sincronización con el robot
 * físico y su estado.
 */
export function MetaAssistantExperience() {
  const companion = useMetaCompanionLink()
  return (
    <AgentApprovalsPathProvider basePath="/dashboard/meta-assistant/approvals">
      <MetaExperience
        brainSlot={<MetaBrainView renderCompanion={renderMetaCompanion} />}
        limitsSlot={
          <AgentLimitsCompact assistantBffPrefix="/api/meta-assistant" />
        }
        activitySlot={
          <AgentActivityFeed
            hideHeader
            appearance="meta"
            emptySlot={
              <MetaActivityEmpty renderCompanion={renderMetaCompanion} />
            }
          />
        }
        approvalsSlot={<AgentPendingApprovals />}
        companion={companion}
        renderCompanion={renderMetaCompanion}
        renderFace={renderMetaFace}
        renderComposer={renderMetaComposer}
        renderPairing={renderMetaPairing}
      />
    </AgentApprovalsPathProvider>
  )
}
