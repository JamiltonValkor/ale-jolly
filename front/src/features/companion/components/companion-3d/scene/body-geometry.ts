import * as THREE from 'three'

import { BODY, FACE_PLATE, bodyFrontZ, bodyPoint } from '../rig/body-profile'
import { FACE, superellipsePoint } from '../rig/face-layout'

/**
 * Mallas del peluche: superficies de revolución con sección elíptica
 * (cuerpo, brazos, pies), la placa de la cara proyectada sobre la capucha y
 * la geometría instanciada de las capas de pelo (comparte los buffers).
 */

type Profile = (phi: number) => { y: number; r: number; z0: number }

function surfacePoint(
  profile: Profile,
  depth: number,
  phi: number,
  theta: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const { y, r, z0 } = profile(phi)
  return out.set(r * Math.sin(theta), y, z0 + depth * r * Math.cos(theta))
}

const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()
const tmpC = new THREE.Vector3()
const tmpD = new THREE.Vector3()

function surfaceNormal(
  profile: Profile,
  depth: number,
  phi: number,
  theta: number,
  out: THREE.Vector3
): THREE.Vector3 {
  if (phi < 1e-4) return out.set(0, -1, 0)
  if (phi > Math.PI - 1e-4) return out.set(0, 1, 0)
  const e = 1e-3
  const p0 = Math.max(phi - e, 1e-4)
  const p1 = Math.min(phi + e, Math.PI - 1e-4)
  surfacePoint(profile, depth, p1, theta, tmpA)
  surfacePoint(profile, depth, p0, theta, tmpB)
  const dPhi = tmpA.sub(tmpB)
  surfacePoint(profile, depth, phi, theta + e, tmpC)
  surfacePoint(profile, depth, phi, theta - e, tmpD)
  const dTheta = tmpC.sub(tmpD)
  return out.crossVectors(dTheta, dPhi).normalize()
}

export function createRevolvedGeometry(
  profile: Profile,
  depth: number,
  around: number,
  along: number
): THREE.BufferGeometry {
  const count = (around + 1) * (along + 1)
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (let i = 0; i <= along; i++) {
    const phi = (i / along) * Math.PI
    for (let j = 0; j <= around; j++) {
      const theta = (j / around) * Math.PI * 2
      const k = i * (around + 1) + j
      surfacePoint(profile, depth, phi, theta, p).toArray(positions, k * 3)
      surfaceNormal(profile, depth, phi, theta, n).toArray(normals, k * 3)
      uvs[k * 2] = j / around
      uvs[k * 2 + 1] = i / along
    }
  }
  const index: number[] = []
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j
      const c = a + around + 1
      index.push(a, a + 1, c, a + 1, c + 1, c)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex(index)
  return g
}

export function createBodyGeometry(around: number, along: number) {
  return createRevolvedGeometry(bodyPoint, BODY.depth, around, along)
}

export interface LimbShape {
  length: number
  radius: number
  /** > 0 ensancha el extremo libre (manito / patita). */
  flare: number
  shape: number
  depth?: number
}

/** Extremidad que cuelga de su pivote: y va de 0 (hombro) a −length. */
export function createLimbGeometry(
  { length, radius, flare, shape, depth = 1 }: LimbShape,
  around: number,
  along: number
): THREE.BufferGeometry {
  const half = length / 2
  const profile: Profile = phi => {
    const c = Math.cos(phi)
    const s = Math.max(Math.sin(phi), 0)
    return {
      y: -half - half * Math.sign(c) * Math.abs(c) ** (2 / shape),
      r: radius * (1 + flare * c) * s ** (2 / shape),
      z0: 0,
    }
  }
  return createRevolvedGeometry(profile, depth, around, along)
}

/** Altura z de la placa: sigue la capucha, un poco más plana. */
export function facePlateZ(x: number, y: number): number {
  const zc = bodyFrontZ(0, FACE_PLATE.centerY)
  const body = bodyFrontZ(x, y)
  // Más plana que la capucha, pero nunca detrás del cuerpo (la barriga de frijol sobresale abajo).
  return Math.max(zc + (body - zc) * FACE_PLATE.follow, body) + 0.006
}

/** Placa de la cara: malla polar con borde de superelipse exacto. */
export function createFacePlateGeometry(
  rings: number,
  steps: number
): THREE.BufferGeometry {
  const positions: number[] = []
  const face: number[] = []
  const push = (fx: number, fy: number) => {
    const x = fx * FACE_PLATE.halfWidth
    const y = FACE_PLATE.centerY + fy * FACE_PLATE.halfWidth
    positions.push(x, y, facePlateZ(x, y))
    face.push(fx, fy)
  }
  push(0, 0)
  for (let k = 1; k <= rings; k++) {
    const s = k / rings
    for (let j = 0; j < steps; j++) {
      const q = superellipsePoint(
        (j / steps) * Math.PI * 2,
        1,
        FACE.aspect,
        FACE.n
      )
      push(q.x * s, q.y * s)
    }
  }
  const index: number[] = []
  for (let j = 0; j < steps; j++) index.push(0, 1 + j, 1 + ((j + 1) % steps))
  for (let k = 1; k < rings; k++) {
    const a0 = 1 + (k - 1) * steps
    const b0 = 1 + k * steps
    for (let j = 0; j < steps; j++) {
      const j1 = (j + 1) % steps
      index.push(a0 + j, b0 + j, b0 + j1, a0 + j, b0 + j1, a0 + j1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 2))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

/** Capas de pelo: una instancia por capa, mismos buffers que la malla base. */
export function createShellGeometry(
  base: THREE.BufferGeometry,
  shells: number
): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  for (const name of Object.keys(base.attributes)) {
    g.setAttribute(name, base.getAttribute(name))
  }
  g.instanceCount = shells
  return g
}
