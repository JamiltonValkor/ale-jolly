import * as THREE from 'three'

import { BODY, headTwistWeight } from '../rig/body-profile'
import type { RigPose } from '../rig/companion-rig'
import type { RenderQuality } from '../rig/render-quality'
import { createSpring, stepSpring, type Spring } from '../rig/spring'
import type { CompanionModel } from './companion-model'

/** Traduce la pose del rig a transformaciones y uniformes de three. */

const ARM_REST = 0.3
const ARM_FORWARD = 0.08
const FOV = 22
/** El pelo se queda atrás y rebota un poco antes de asentarse. */
const FUR_SPRING = { stiffness: 60, damping: 0.42 }

export interface PoseMemory {
  prev: THREE.Vector3
  prevRoll: number
  prevYaw: number
  lag: { x: Spring; y: Spring; z: Spring }
  primed: boolean
}

export function createPoseMemory(): PoseMemory {
  return {
    prev: new THREE.Vector3(),
    prevRoll: 0,
    prevYaw: 0,
    lag: { x: createSpring(0), y: createSpring(0), z: createSpring(0) },
    primed: false,
  }
}

function applyFace(model: CompanionModel, pose: RigPose) {
  const u = model.faceMaterial.uniforms
  const f = pose.face
  u.uEyeOpenL.value = f.eyeOpenL
  u.uEyeOpenR.value = f.eyeOpenR
  u.uEyeScale.value = f.eyeScale
  u.uLid.value = f.lidCurve
  u.uFocus.value = f.focus
  ;(u.uGaze.value as THREE.Vector2).set(f.gazeX, f.gazeY)
  u.uSmile.value = f.smile
  u.uMouthOpen.value = f.mouthOpen
  u.uMouthWidth.value = f.mouthWidth
  u.uMouthRound.value = f.mouthRound
  u.uBlush.value = f.blush
}

/** Movimiento secundario del pelo: inercia con resorte subamortiguado. */
function applyFurLag(
  model: CompanionModel,
  pose: RigPose,
  memory: PoseMemory,
  dt: number
) {
  let vx = 0
  let vy = 0
  let vz = 0
  if (dt > 0 && memory.primed) {
    vx =
      (pose.rootX - memory.prev.x) / dt -
      ((pose.bodyRoll - memory.prevRoll) / dt) * 1.2
    vy = (pose.rootY - memory.prev.y) / dt
    vz =
      (pose.rootZ - memory.prev.z) / dt +
      ((pose.bodyYaw - memory.prevYaw) / dt) * 0.15
  }
  memory.prev.set(pose.rootX, pose.rootY, pose.rootZ)
  memory.prevRoll = pose.bodyRoll
  memory.prevYaw = pose.bodyYaw
  memory.primed = true
  const target = (v: number) => THREE.MathUtils.clamp(-v * 0.2, -0.7, 0.7)
  memory.lag.x = stepSpring(memory.lag.x, target(vx), dt, FUR_SPRING)
  memory.lag.y = stepSpring(memory.lag.y, target(vy), dt, FUR_SPRING)
  memory.lag.z = stepSpring(memory.lag.z, target(vz), dt, FUR_SPRING)
  for (const p of model.parts) {
    p.uniforms.uInertia.value.set(
      memory.lag.x.value,
      memory.lag.y.value,
      memory.lag.z.value
    )
  }
}

/** El hombro rueda hacia adelante cuando el brazo sube por delante. */
const shoulderForward = (swing: number) =>
  0.12 * THREE.MathUtils.smoothstep(swing, 0.5, 2.0)

const neck = new THREE.Vector3(0, BODY.neckY, BODY.neckZ)
const twistEuler = new THREE.Euler()
const twistQuat = new THREE.Quaternion()

/**
 * Los hombros son parte de la pieza rígida de arriba: el brazo gira con la
 * capucha (mismo giro y pivote que deformBody aplica al cuerpo a esa altura),
 * así la mano no se despega ni se hunde cuando mira hacia un lado.
 */
function turnWithHood(arm: THREE.Group, pose: RigPose) {
  const w = headTwistWeight(arm.position.y)
  twistEuler.set(pose.headPitch * w, pose.headYaw * w, pose.headRoll * w, 'YXZ')
  twistQuat.setFromEuler(twistEuler)
  arm.position.sub(neck).applyQuaternion(twistQuat).add(neck)
  arm.quaternion.premultiply(twistQuat)
}

interface ArmPose {
  raise: number
  swing: number
  reach: number
}

function applyArm(
  arm: THREE.Group,
  side: -1 | 1,
  shoulder: CompanionModel['shoulder'],
  a: ArmPose,
  pose: RigPose
) {
  arm.position.set(
    side * shoulder.x,
    shoulder.y,
    shoulder.z + shoulderForward(a.swing)
  )
  arm.rotation.set(-(ARM_FORWARD + a.swing), 0, side * (ARM_REST + a.raise))
  arm.scale.set(1, Math.max(0.6, 1 + a.reach), 1)
  turnWithHood(arm, pose)
}

function applyLimbs(model: CompanionModel, pose: RigPose) {
  const { shoulder } = model
  applyArm(
    model.armR,
    1,
    shoulder,
    { raise: pose.armRaiseR, swing: pose.armSwingR, reach: pose.armReachR },
    pose
  )
  applyArm(
    model.armL,
    -1,
    shoulder,
    { raise: pose.armRaiseL, swing: pose.armSwingL, reach: pose.armReachL },
    pose
  )
  const [footL, footR] = model.feet
  footL.position.y = model.footBaseY + Math.max(0, pose.footLiftL)
  footR.position.y = model.footBaseY + Math.max(0, pose.footLiftR)
  footL.rotation.x = -pose.footLiftL * 2.5
  footR.rotation.x = -pose.footLiftR * 2.5
}

export function applyPose(
  model: CompanionModel,
  pose: RigPose,
  memory: PoseMemory,
  dt: number
): void {
  const s = Math.max(pose.squash, 0.5)
  const side = 1 / Math.sqrt(s)
  model.root.position.set(pose.rootX, pose.rootY, pose.rootZ)
  model.root.scale.set(side, s, side)
  model.root.rotation.set(pose.bodyPitch, pose.bodyYaw, pose.bodyRoll, 'YXZ')
  model.shared.uHeadRot.value.set(pose.headPitch, pose.headYaw, pose.headRoll)
  model.shared.uBreath.value = pose.breath
  model.shared.uIri.value = pose.iridescence
  model.shared.uSync.value = pose.syncWave
  applyLimbs(model, pose)
  applyFace(model, pose)
  applyFurLag(model, pose, memory, dt)
  const lift = THREE.MathUtils.clamp(pose.rootY, 0, 1)
  model.shadow.position.x = pose.rootX
  model.shadow.position.z = 0.12 + pose.rootZ
  model.shadow.scale.setScalar(1 - lift * 0.9)
  model.shadowMaterial.uniforms.uStrength.value =
    0.55 * Math.max(0, 1 - lift * 1.6)
}

const FRAMES: Record<
  RenderQuality['framing'],
  { cy: number; hw: number; hh: number }
> = {
  full: { cy: 1.24, hw: 1.45, hh: 1.42 },
  portrait: { cy: 1.5, hw: 0.66, hh: 0.6 },
  /** Primer plano de la capucha con el halo de pelo alrededor. */
  head: { cy: 1.52, hw: 0.9, hh: 0.84 },
}

/** Encuadra el personaje completo (con margen para saltos y brazos), o la cabeza para el avatar. */
export function frameCamera(
  camera: THREE.PerspectiveCamera,
  aspect: number,
  framing: RenderQuality['framing']
): void {
  const box = FRAMES[framing]
  const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
  const d = Math.max(box.hh / t, box.hw / (t * Math.max(aspect, 0.1)))
  camera.fov = FOV
  camera.aspect = aspect
  camera.position.set(0, box.cy + d * 0.05, d + 0.4)
  camera.lookAt(0, box.cy, 0)
  camera.updateProjectionMatrix()
}
