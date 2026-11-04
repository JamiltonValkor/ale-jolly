'use client'

import { EmbeddedComposerV2 } from '@/features/agent-chat'
import type { ComposerRenderInput } from '@/features/sales-assistant'

/**
 * El chat de Meta Assistant con el compositor real del chat del modo agente
 * (haz de luz, dictado, botón animado). Vive en la capa de composición porque
 * junta dos features.
 */
export function renderMetaComposer(input: ComposerRenderInput) {
  return (
    <EmbeddedComposerV2
      value={input.value}
      onValueChange={input.onChange}
      onSubmit={input.onSend}
      canSubmit={input.canSend}
      label={input.label}
      placeholder={input.placeholder}
      disclaimer={input.disclaimer}
      maxLength={input.textLimit}
      enforceMaxLength={false}
      inputRef={input.inputRef}
      leading={input.leading}
    />
  )
}
