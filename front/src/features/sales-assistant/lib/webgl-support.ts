import { useSyncExternalStore } from 'react'

/** El navegador puede crear un contexto WebGL (sigma lo necesita). */
export function supportsWebGL(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

const noopSubscribe = () => () => undefined

/** En el servidor y sin WebGL devuelve false: se pinta la lista alternativa. */
export function useWebGLSupport(): boolean {
  return useSyncExternalStore(noopSubscribe, supportsWebGL, () => false)
}
