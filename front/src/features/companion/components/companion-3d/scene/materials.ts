import * as THREE from 'three'

import { BODY, FACE_PLATE } from '../rig/body-profile'
import { FACE_FRAGMENT, FACE_VERTEX } from './face-shader'
import {
  COMMON_GLSL,
  FUR_FRAGMENT,
  FUR_VERTEX,
  LIGHT_GLSL,
} from './shader-chunks'

/**
 * Materiales del peluche. Los uniformes animados y las luces son objetos
 * compartidos: actualizarlos una vez actualiza todas las piezas.
 */

type U<T> = { value: T }

const color = (hex: string) => new THREE.Color(hex)
const dir = (x: number, y: number, z: number) =>
  new THREE.Vector3(x, y, z).normalize()

/** Iridiscencia de Saleads: #FF86C8 · #A98DFF · #62C6FF · #5FE3C0 · #FFCF8F */
export const IRIDESCENCE = [
  '#FF86C8',
  '#A98DFF',
  '#62C6FF',
  '#5FE3C0',
  '#FFCF8F',
] as const

export function createSharedUniforms() {
  return {
    uTime: { value: 0 } as U<number>,
    uHeadRot: { value: new THREE.Vector3() } as U<THREE.Vector3>,
    uNeckY: { value: BODY.neckY } as U<number>,
    uBreath: { value: 0 } as U<number>,
    uIri: { value: 0 } as U<number>,
    uSync: { value: 0 } as U<number>,
    // Luces en espacio de vista (la cámara no se mueve).
    uKeyDir: { value: dir(-0.5, 0.72, 0.62) },
    uKeyColor: { value: color('#FFF3E4').multiplyScalar(1.12) },
    uFillDir: { value: dir(0.75, -0.05, 0.7) },
    uFillColor: { value: color('#B9C6DE').multiplyScalar(0.3) },
    uRimDirA: { value: dir(-0.9, 0.3, -0.35) },
    uRimColorA: { value: color('#D9E6FF').multiplyScalar(1.55) },
    uRimDirB: { value: dir(0.9, 0.42, -0.3) },
    uRimColorB: { value: color('#FFE7CF').multiplyScalar(1.3) },
    uAmbient: { value: color('#4A4643') },
    uIri0: { value: color(IRIDESCENCE[0]) },
    uIri1: { value: color(IRIDESCENCE[1]) },
    uIri2: { value: color(IRIDESCENCE[2]) },
    uIri3: { value: color(IRIDESCENCE[3]) },
    uIri4: { value: color(IRIDESCENCE[4]) },
  }
}

export type SharedUniforms = ReturnType<typeof createSharedUniforms>

export interface FurOptions {
  furLength: number
  shells: number
  strandFreq: number
  /** Aplica respiración y giro de capucha (solo cuerpo). */
  deform: boolean
  /** Despeja el pelo sobre la placa de la cara (solo cuerpo). */
  face: boolean
  softness?: number
  /** Altura bajo la cual el pelo y el cuerpo se desvanecen (encuadre «head»). */
  fadeY?: number
  /** Lado que mira hacia afuera del cuerpo (brazos): el lado de adentro queda en sombra. */
  outward?: THREE.Vector3
  /** Posición de reposo de la pieza en el cuerpo (hombro, tobillo): su luz y oclusión siguen al cuerpo. */
  origin?: THREE.Vector3
}

/** Marfil: punta clara, raíz cálida un poco más oscura. */
export const FUR_TIP = '#F8F2E8'
export const FUR_ROOT = '#D3C6B4'

export function createFurMaterials(shared: SharedUniforms, o: FurOptions) {
  const part = {
    uShells: { value: o.shells },
    uFurLen: { value: o.furLength },
    uDeform: { value: o.deform ? 1 : 0 },
    uHasFace: { value: o.face ? 1 : 0 },
    uFace: {
      value: new THREE.Vector4(
        FACE_PLATE.centerY,
        FACE_PLATE.halfWidth,
        FACE_PLATE.halfHeight,
        FACE_PLATE.n
      ),
    },
    uGravity: { value: new THREE.Vector3(0, -0.35, 0.08) },
    uInertia: { value: new THREE.Vector3() },
    uTipColor: { value: color(FUR_TIP) },
    uRootColor: { value: color(FUR_ROOT) },
    uStrandFreq: { value: o.strandFreq },
    uSoft: { value: o.softness ?? 0 },
    uFadeY: { value: o.fadeY ?? -10 },
    uOutward: { value: o.outward ?? new THREE.Vector3() },
    uOrigin: { value: o.origin ?? new THREE.Vector3() },
  }
  const make = (isShell: boolean) =>
    new THREE.ShaderMaterial({
      uniforms: { ...shared, ...part, uIsShell: { value: isShell ? 1 : 0 } },
      vertexShader: FUR_VERTEX,
      fragmentShader: FUR_FRAGMENT,
      transparent: isShell,
      depthWrite: !isShell,
      premultipliedAlpha: isShell,
      blending: THREE.NormalBlending,
    })
  return { base: make(false), shell: make(true), part }
}

export function createFaceMaterial(shared: SharedUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uCream: { value: color('#F8ECDA') },
      uInk: { value: color('#151113') },
      uBlushColor: { value: color('#FF9AA6') },
      uMouthColor: { value: color('#5A2A30') },
      uEyeOpenL: { value: 1 },
      uEyeOpenR: { value: 1 },
      uEyeScale: { value: 1 },
      uLid: { value: 0 },
      uFocus: { value: 0 },
      uGaze: { value: new THREE.Vector2() },
      uSmile: { value: 0.6 },
      uMouthOpen: { value: 0 },
      uMouthWidth: { value: 1 },
      uMouthRound: { value: 0 },
      uBlush: { value: 0.8 },
    },
    vertexShader: FACE_VERTEX,
    fragmentShader: FACE_FRAGMENT,
  })
}

const SIMPLE_VERTEX = /* glsl */ `
varying vec3 vN;
varying vec3 vViewPos;
varying vec2 vPos;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vViewPos = mv.xyz;
  vPos = position.xy;
  gl_Position = projectionMatrix * mv;
}
`

/** Etiqueta de tela grafito donde va cosido el isotipo. */
export function createTagMaterial(shared: SharedUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uTagColor: { value: color('#1B1A1F') } },
    vertexShader: SIMPLE_VERTEX,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${LIGHT_GLSL}
      uniform vec3 uTagColor;
      varying vec3 vN;
      varying vec3 vViewPos;
      void main() {
        vec3 N = normalize(vN);
        if (!gl_FrontFacing) N = -N;
        float ndv = clamp(dot(N, normalize(-vViewPos)), 0.0, 1.0);
        vec3 light = uAmbient + uKeyColor * wrapDiffuse(N, uKeyDir, 0.5) + uFillColor;
        vec3 c = uTagColor * light + rimLight(N, ndv) * 0.15;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
  })
}

/** Isotipo con la iridiscencia de Saleads; brilla más en momentos de IA. */
export function createIsotypeMaterial(shared: SharedUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: SIMPLE_VERTEX,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${LIGHT_GLSL}
      uniform float uIri;
      varying vec2 vPos;
      void main() {
        float t = vPos.y * 3.2 + vPos.x * 2.0 - uTime * 0.12;
        vec3 c = iriPalette(t) * (0.95 + 0.7 * uIri);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
  })
}

/** Sombra de contacto suave en un piso invisible. */
export function createShadowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.55 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        vec2 q = (vUv - 0.5) * 2.0;
        float a = exp(-dot(q, q) * 3.2) * uStrength;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
  })
}
