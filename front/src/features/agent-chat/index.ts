/**
 * Stub del modo local: el barrel real de `@/features/agent-chat` arrastra unos
 * 1.650 archivos. Meta Assistant solo usa el compositor, importado directo.
 */
export {
  EmbeddedComposerV2,
  type EmbeddedComposerV2Props,
} from './components/shell/embedded-composer-v2'

/** La tarjeta del modo agente clásico no existe en el modo local. */
export function AgentModeSidebarCard(): null {
  return null
}
