'use client'

import { renderMetaComposer } from '@/shared/shells/meta-chat-composer'
import {
  renderMetaCompanion,
  renderMetaFace,
} from '@/shared/shells/meta-companion'
import { MetaAssistantLab, type LabScreen } from './meta-assistant-lab'
import { MetaAssistantLabSidebar } from './meta-assistant-lab-sidebar'

/** `sidebar` no es una pestaña de Meta: es su entrada en el menú lateral. */
export type LabClientScreen = LabScreen | 'sidebar'

interface Props {
  screen: LabClientScreen
  /** `?companion=3d` dibuja el personaje WebGL en cada pantalla. */
  companion: boolean
}

export function MetaAssistantLabClient({ screen, companion }: Props) {
  if (screen === 'sidebar') return <MetaAssistantLabSidebar />
  return (
    <MetaAssistantLab
      screen={screen}
      renderCompanion={companion ? renderMetaCompanion : undefined}
      renderFace={companion ? renderMetaFace : undefined}
      renderComposer={renderMetaComposer}
    />
  )
}
