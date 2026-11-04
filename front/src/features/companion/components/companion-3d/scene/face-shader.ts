// TDD-SKIP: GLSL source strings only; they compile on the GPU (no WebGL in happy-dom). Uniform wiring is covered by materials.test.ts.
import { FACE } from '../rig/face-layout'
import { COMMON_GLSL, LIGHT_GLSL } from './shader-chunks'

/**
 * Cara dibujada con SDF en el shader: nítida a cualquier tamaño (también a
 * 48 px), sin subir texturas por frame. Misma geometría que la pantalla del
 * robot (face-layout.ts).
 */

const g = (v: number) => v.toFixed(4)

export const FACE_VERTEX = /* glsl */ `
${COMMON_GLSL}
attribute vec2 aFace;
varying vec2 vFace;
varying vec3 vN;
varying vec3 vViewPos;

void main() {
  vec3 n = normal;
  vec3 p = deformBody(position, n);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFace = aFace;
  vN = normalize(normalMatrix * n);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`

export const FACE_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
${LIGHT_GLSL}
uniform vec3 uCream;
uniform vec3 uInk;
uniform vec3 uBlushColor;
uniform vec3 uMouthColor;
uniform float uEyeOpenL;
uniform float uEyeOpenR;
uniform float uEyeScale;
uniform float uLid;
uniform float uFocus;
uniform vec2 uGaze;
uniform float uSmile;
uniform float uMouthOpen;
uniform float uMouthWidth;
uniform float uMouthRound;
uniform float uBlush;
uniform float uIri;

varying vec2 vFace;
varying vec3 vN;
varying vec3 vViewPos;

const float EYE_X = ${g(FACE.eye.x)};
const float EYE_Y = ${g(FACE.eye.y)};
const float EYE_R = ${g(FACE.eye.r)};
const float EYE_SY = ${g(FACE.eye.stretchY)};
const vec3 HL = vec3(${g(FACE.highlight.dx)}, ${g(FACE.highlight.dy)}, ${g(FACE.highlight.r)});
const vec3 HL2 = vec3(${g(FACE.highlightSmall.dx)}, ${g(FACE.highlightSmall.dy)}, ${g(FACE.highlightSmall.r)});
const vec4 BLUSH = vec4(${g(FACE.blush.x)}, ${g(FACE.blush.y)}, ${g(FACE.blush.rx)}, ${g(FACE.blush.ry)});
const vec4 MOUTH = vec4(${g(FACE.mouth.y)}, ${g(FACE.mouth.halfWidth)}, ${g(FACE.mouth.depth)}, ${g(FACE.mouth.thickness)});
const vec2 GAZE = vec2(${g(FACE.gaze.x)}, ${g(FACE.gaze.y)});
const float ASPECT = ${g(FACE.aspect)};
const float SE_N = ${g(FACE.n)};

float sdEllipse(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

// Arco de parábola y = curve·(1 − (x/hw)²) con grosor th.
float sdArc(vec2 p, float hw, float curve, float th) {
  if (abs(p.x) > hw) {
    return length(vec2(abs(p.x) - hw, p.y)) - th;
  }
  float x = p.x / hw;
  float y = curve * (1.0 - x * x);
  float slope = -2.0 * curve * x / hw;
  return abs(p.y - y) / sqrt(1.0 + slope * slope) - th;
}

float fill(float d) {
  float aa = max(fwidth(d), 1e-4) * 0.85;
  return 1.0 - smoothstep(-aa, aa, d);
}

float eyeSdf(vec2 q, float open) {
  float r = EYE_R * uEyeScale;
  q.y += r * (1.0 - open) * 0.28;
  float dOpen = sdEllipse(q, vec2(r, r * EYE_SY * max(open, 0.05)));
  // Mirada concentrada: el párpado inferior sube con un borde curvo suave.
  float lower = -r * EYE_SY + uFocus * r * 1.05 + q.x * q.x / r * 0.35 * uFocus;
  dOpen = max(dOpen, lower - q.y);
  float lid = uLid;
  float dClosed = sdArc(q + vec2(0.0, r * 0.22 * lid), r * 1.04, lid * r * 0.55, r * 0.15);
  return mix(dClosed, dOpen, smoothstep(0.1, 0.5, open));
}

// Ojo: devuelve (máscara de tinta, brillo).
vec2 eye(vec2 p, float side, float open) {
  vec2 c = vec2(side * EYE_X, EYE_Y) + uGaze * GAZE;
  vec2 q = p - c;
  float ink = fill(eyeSdf(q, open));
  float r = EYE_R * uEyeScale;
  float shine = smoothstep(0.5, 0.85, open);
  float hl = fill(length(q - HL.xy * r) - HL.z * r);
  float hl2 = fill(length(q - HL2.xy * r) - HL2.z * r) * 0.85;
  return vec2(ink, max(hl, hl2) * shine * ink);
}

// Boca: (máscara total, máscara del interior). Sonrisa/«D» abierta que se
// transforma en una «O» redonda (bostezo, sorpresa, ronquido).
vec2 mouth(vec2 p) {
  vec2 q = p - vec2(uGaze.x * 0.025, MOUTH.x + uGaze.y * 0.015);
  float hw = MOUTH.y * uMouthWidth * (1.0 + 0.22 * uMouthOpen);
  float dip = MOUTH.z * uSmile;
  float line = sdArc(q, hw, -dip, MOUTH.w * 0.5);
  float x = clamp(q.x / hw, -1.0, 1.0);
  float inside = 1.0 - x * x;
  float yTop = mix(-dip * inside, -dip * inside * 0.35, uMouthOpen);
  float yBot = -dip * inside - uMouthOpen * 0.2 * pow(max(inside, 0.0), 0.75);
  float dOpen = uMouthOpen > 0.02 ? max(max(q.y - yTop, yBot - q.y), abs(q.x) - hw) : 1.0;
  float rr = 0.6 + 0.85 * uMouthOpen;
  float dO = sdEllipse(q - vec2(0.0, -0.035), vec2(0.082, 0.098) * rr);
  float dTotal = mix(min(line, dOpen), dO - MOUTH.w * 0.35, uMouthRound);
  float dInside = mix(dOpen, dO, uMouthRound);
  return vec2(fill(dTotal), fill(dInside));
}

void main() {
  vec2 p = vFace;
  vec3 N = normalize(vN);
  vec3 V = normalize(-vViewPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec2 bq = vec2(abs(p.x) - BLUSH.x, p.y - BLUSH.y) / BLUSH.zw;
  float blush = exp(-dot(bq, bq) * 1.6) * uBlush * 0.62;
  vec3 base = mix(uCream, uBlushColor, blush);
  base *= 1.0 + 0.05 * p.y;
  vec2 eL = eye(p, -1.0, uEyeOpenL);
  vec2 eR = eye(p, 1.0, uEyeOpenR);
  vec2 m = mouth(p);
  vec3 col = mix(base, uInk, max(eL.x, eR.x));
  col = mix(col, uMouthColor, m.y);
  col = mix(col, uInk, m.x * (1.0 - m.y));
  float se = pow(pow(abs(p.x), SE_N) + pow(abs(p.y / ASPECT), SE_N), 1.0 / SE_N);
  float hood = mix(0.8, 1.0, smoothstep(0.0, 0.2, 1.0 - se));
  float key = wrapDiffuse(N, uKeyDir, 0.9);
  float fillL = wrapDiffuse(N, uFillDir, 1.0);
  vec3 light = uAmbient * 1.35 + uKeyColor * key * 0.78 + uFillColor * fillL;
  vec3 lit = col * light * hood;
  lit += rimLight(N, ndv) * 0.18;
  // Terciopelo: un brillo suave hacia los bordes de la placa.
  lit += uKeyColor * pow(1.0 - ndv, 2.5) * 0.08 * (0.5 + 0.5 * key);
  vec3 shineCol = mix(vec3(1.0), iriPalette(p.x * 0.6 + uTime * 0.1), uIri * 0.35);
  lit = mix(lit, shineCol * 1.08, max(eL.y, eR.y));
  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
