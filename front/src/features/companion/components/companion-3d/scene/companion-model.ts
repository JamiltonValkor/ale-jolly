import * as THREE from 'three'

import { bodyPhiAtY, bodyPoint, BODY } from '../rig/body-profile'
import type { RenderQuality } from '../rig/render-quality'
import {
  createBodyGeometry,
  createFacePlateGeometry,
  createLimbGeometry,
  createShellGeometry,
  type LimbShape,
} from './body-geometry'
import { createIsotypeGeometry, createTagGeometry } from './isotype'
import {
  createFaceMaterial,
  createFurMaterials,
  createIsotypeMaterial,
  createShadowMaterial,
  createSharedUniforms,
  createTagMaterial,
  type SharedUniforms,
} from './materials'

/**
 * Arma el peluche: cuerpo con capucha, placa de la cara, brazos y pies en
 * pivotes (para poder moverlos), etiqueta con el isotipo y sombra de contacto.
 * El origen de `root` está en el piso: aplastar/estirar no despega los pies.
 */

const BODY_FUR = 0.062
const BODY_STRANDS = 92

export interface FurPart {
  base: THREE.Mesh
  shells: THREE.Mesh
  uniforms: ReturnType<typeof createFurMaterials>['part']
  furLength: number
}

export interface CompanionModel {
  root: THREE.Group
  shared: SharedUniforms
  parts: FurPart[]
  face: THREE.Mesh
  faceMaterial: THREE.ShaderMaterial
  armL: THREE.Group
  armR: THREE.Group
  /** Hombro derecho en reposo (el izquierdo es su espejo en x); pose-binding lo adelanta al subir el brazo. */
  shoulder: { x: number; y: number; z: number }
  /** Pivotes de los pies (izquierda, derecha de la pantalla) y su altura de reposo. */
  feet: THREE.Group[]
  footBaseY: number
  shadow: THREE.Mesh
  shadowMaterial: THREE.ShaderMaterial
  setQuality(q: RenderQuality): void
  dispose(): void
}

function createFurPart(
  geometry: THREE.BufferGeometry,
  shared: SharedUniforms,
  q: RenderQuality,
  o: {
    furLength: number
    deform: boolean
    face: boolean
    order: number
    outward?: THREE.Vector3
    origin?: THREE.Vector3
    fadeY?: number
  }
): FurPart {
  const mats = createFurMaterials(shared, {
    furLength: o.furLength * q.furScale,
    shells: q.shells,
    strandFreq: BODY_STRANDS * q.strandScale,
    deform: o.deform,
    face: o.face,
    softness: q.softness,
    outward: o.outward,
    origin: o.origin,
    fadeY: o.fadeY,
  })
  const base = new THREE.Mesh(geometry, mats.base)
  const shells = new THREE.Mesh(
    createShellGeometry(geometry, q.shells),
    mats.shell
  )
  shells.frustumCulled = false
  shells.renderOrder = o.order
  base.add(shells)
  return { base, shells, uniforms: mats.part, furLength: o.furLength }
}

const ARM: LimbShape = {
  length: 0.58,
  radius: 0.18,
  flare: 0.14,
  shape: 2.3,
  depth: 0.88,
}
const FOOT: LimbShape = {
  length: 0.27,
  radius: 0.2,
  flare: 0.05,
  shape: 2.4,
  depth: 1.4,
}
const FOOT_BASE_Y = FOOT.length + 0.005
const SHOULDER = { x: 0.78, y: 1.05, z: 0.13 } as const
/** En el retrato, el cuerpo se desvanece desde aquí hacia abajo. */
const HEAD_FADE_Y = 0.62

function createArm(shared: SharedUniforms, q: RenderQuality, side: -1 | 1) {
  const pivot = new THREE.Group()
  pivot.position.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z)
  const arm = createFurPart(createLimbGeometry(ARM, 40, 28), shared, q, {
    furLength: 0.052,
    deform: false,
    face: false,
    order: 3,
    outward: new THREE.Vector3(side, 0, 0.35).normalize(),
    origin: pivot.position.clone(),
  })
  pivot.add(arm.base)
  return { pivot, part: arm }
}

function createFoot(shared: SharedUniforms, q: RenderQuality, side: -1 | 1) {
  const pivot = new THREE.Group()
  pivot.position.set(side * 0.34, FOOT_BASE_Y, 0.3)
  const foot = createFurPart(createLimbGeometry(FOOT, 36, 20), shared, q, {
    furLength: 0.042,
    deform: false,
    face: false,
    order: 1,
    origin: pivot.position.clone(),
  })
  pivot.rotation.y = side * 0.12
  pivot.add(foot.base)
  return { pivot, part: foot }
}

/** Etiqueta cosida en la costura (lado derecho de la pantalla) con el isotipo. */
function createTag(shared: SharedUniforms) {
  const group = new THREE.Group()
  const y = 0.4
  const { r, z0 } = bodyPoint(bodyPhiAtY(y))
  const theta = 0.98
  const out = r + 0.035
  group.position.set(
    Math.sin(theta) * out,
    y,
    z0 + BODY.depth * Math.cos(theta) * out
  )
  group.rotation.set(-0.05, 0.62, -0.22)
  const label = new THREE.Mesh(
    createTagGeometry(0.13, 0.18, 0.045),
    createTagMaterial(shared)
  )
  label.position.set(0.05, -0.05, 0)
  const mark = new THREE.Mesh(
    createIsotypeGeometry(0.11),
    createIsotypeMaterial(shared)
  )
  mark.position.set(0.05, -0.05, 0.004)
  group.add(label, mark)
  return group
}

function createShadow() {
  const material = createShadowMaterial()
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.7), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(0, 0.002, 0.12)
  mesh.renderOrder = 0
  return { mesh, material }
}

function disposeTree(root: THREE.Object3D) {
  root.traverse(o => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) m.dispose()
    }
  })
}

export interface ModelOptions {
  /** Solo la cabeza (encuadre «head»): sin brazos, pies, etiqueta ni sombra. */
  headOnly?: boolean
}

/** Brazos y pies con su pelo; en modo cabeza quedan pivotes vacíos (no cuestan nada). */
function buildLimbs(
  shared: SharedUniforms,
  q: RenderQuality,
  headOnly: boolean
) {
  if (headOnly) {
    return {
      armL: new THREE.Group(),
      armR: new THREE.Group(),
      feet: [new THREE.Group(), new THREE.Group()],
      parts: [],
    }
  }
  const armL = createArm(shared, q, -1)
  const armR = createArm(shared, q, 1)
  const feet = [createFoot(shared, q, -1), createFoot(shared, q, 1)]
  return {
    armL: armL.pivot,
    armR: armR.pivot,
    feet: feet.map(f => f.pivot),
    parts: [armL.part, armR.part, ...feet.map(f => f.part)],
  }
}

export function buildCompanionModel(
  q: RenderQuality,
  opts: ModelOptions = {}
): CompanionModel {
  const headOnly = !!opts.headOnly
  const shared = createSharedUniforms()
  const root = new THREE.Group()
  const { around, along } = q.segments
  const body = createFurPart(createBodyGeometry(around, along), shared, q, {
    furLength: BODY_FUR,
    deform: true,
    face: true,
    order: 2,
    fadeY: headOnly ? HEAD_FADE_Y : undefined,
  })
  const faceMaterial = createFaceMaterial(shared)
  const face = new THREE.Mesh(createFacePlateGeometry(22, 96), faceMaterial)
  const limbs = buildLimbs(shared, q, headOnly)
  root.add(body.base, face, limbs.armL, limbs.armR, ...limbs.feet)
  if (!headOnly) root.add(createTag(shared))
  const shadow = createShadow()
  shadow.mesh.visible = !headOnly
  const parts = [body, ...limbs.parts]
  return {
    root,
    shared,
    parts,
    face,
    faceMaterial,
    armL: limbs.armL,
    armR: limbs.armR,
    shoulder: SHOULDER,
    feet: limbs.feet,
    footBaseY: FOOT_BASE_Y,
    shadow: shadow.mesh,
    shadowMaterial: shadow.material,
    setQuality(next) {
      for (const p of parts) {
        ;(p.shells.geometry as THREE.InstancedBufferGeometry).instanceCount =
          next.shells
        p.uniforms.uShells.value = next.shells
        p.uniforms.uFurLen.value = p.furLength * next.furScale
        p.uniforms.uStrandFreq.value = BODY_STRANDS * next.strandScale
        p.uniforms.uSoft.value = next.softness
      }
    },
    dispose() {
      disposeTree(root)
      disposeTree(shadow.mesh)
    },
  }
}
