// TDD-SKIP: constant data table (arm angles per target), exercised through companion-actions.test.ts and performances.test.ts.
/**
 * Poses de brazo calculadas desde el hombro (raise = afuera/arriba,
 * swing = adelante/arriba, reach = estirón de peluche). El hombro rueda hacia
 * adelante al subir el brazo (pose-binding.ts), así la mano queda delante del
 * cuerpo y no dentro de él.
 */
export const ARM = {
  cheek: { raise: -0.84, swing: 2.11, reach: 0.33 },
  chin: { raise: -1.01, swing: 1.71, reach: 0.45 },
  eyes: { raise: -0.87, swing: 2.23, reach: 0.44 },
  typing: { raise: -0.88, swing: 1.29, reach: 0.41 },
  headSide: { raise: 2.9, swing: 0.1, reach: 0.2 },
  lookHand: { raise: -0.74, swing: 1.74, reach: 0.47 },
  belly: { raise: -0.82, swing: 1.21, reach: 0.38 },
  present: { raise: 1.1, swing: 0.5, reach: 0.08 },
  up: { raise: 2.35, swing: 0.15, reach: 0 },
  shrug: { raise: 0.55, swing: 0.3, reach: 0 },
} as const

export type ArmPoseName = keyof typeof ARM
