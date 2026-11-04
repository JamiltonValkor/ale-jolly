// API pública del compañero (personaje 3D, cara y sincronización con el robot físico).
export {
  Companion3D,
  type CompanionHandle,
  type PlayOptions,
} from './components/companion-3d/companion-3d'
export type {
  CompanionAction as Companion3DAction,
  CompanionMood as Companion3DMood,
} from './components/companion-3d/rig/companion-moods'
export { CompanionFace, type SayLine } from './components/face/companion-face'
export { CompanionPairingFlow } from './components/pairing/companion-pairing-flow'
export type {
  CompanionMood as PairingCompanionMood,
  CompanionRenderInput as PairingCompanionRenderInput,
  RenderCompanion as PairingRenderCompanion,
} from './components/pairing/flow-companion'
export { resolveTransportMode } from './hooks/use-pairing-transport'
export {
  useCompanionLink,
  type CompanionPresence,
} from './hooks/use-companion-link'
