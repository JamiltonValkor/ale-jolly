// TDD-SKIP: GLSL source strings only; they compile on the GPU (no WebGL in happy-dom). Uniform wiring is covered by materials.test.ts.

/**
 * GLSL compartido. Iluminación de peluche: difusa envolvente, oclusión por
 * capas (raíz oscura, punta clara), brillo de borde (sheen) y luz de contorno
 * fría/cálida que separa al personaje del negro puro. La iridiscencia de
 * Saleads solo entra como sheen/contorno en momentos de IA.
 */

import { BODY } from '../rig/body-profile'

const g = (v: number) => v.toFixed(4)

export const COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uHeadRot;
uniform float uNeckY;
uniform float uBreath;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

mat3 rotationXYZ(vec3 r) {
  float cx = cos(r.x); float sx = sin(r.x);
  float cy = cos(r.y); float sy = sin(r.y);
  float cz = cos(r.z); float sz = sin(r.z);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  return ry * rx * rz;
}

// Respiración en la barriga y giro de la capucha. Cara, capucha y hombros giran
// como una sola pieza rígida (la placa nunca se tuerce ni se aplasta); la
// torsión se reparte en la barriga. Mismo peso que headTwistWeight().
vec3 deformBody(vec3 p, inout vec3 n) {
  float belly = exp(-pow((p.y - 0.8) / 0.55, 2.0));
  p.xz *= 1.0 + uBreath * belly;
  float w = smoothstep(${g(BODY.twistFrom)}, ${g(BODY.twistTo)}, p.y);
  mat3 R = rotationXYZ(uHeadRot * w);
  vec3 pivot = vec3(0.0, uNeckY, ${g(BODY.neckZ)});
  n = R * n;
  return pivot + R * (p - pivot);
}
`

export const LIGHT_GLSL = /* glsl */ `
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uRimDirA;
uniform vec3 uRimColorA;
uniform vec3 uRimDirB;
uniform vec3 uRimColorB;
uniform vec3 uAmbient;
uniform vec3 uIri0;
uniform vec3 uIri1;
uniform vec3 uIri2;
uniform vec3 uIri3;
uniform vec3 uIri4;

vec3 iriPalette(float t) {
  t = fract(t) * 5.0;
  float i = floor(t);
  float f = smoothstep(0.0, 1.0, fract(t));
  vec3 a = i < 1.0 ? uIri0 : i < 2.0 ? uIri1 : i < 3.0 ? uIri2 : i < 4.0 ? uIri3 : uIri4;
  vec3 b = i < 1.0 ? uIri1 : i < 2.0 ? uIri2 : i < 3.0 ? uIri3 : i < 4.0 ? uIri4 : uIri0;
  return mix(a, b, f);
}

float wrapDiffuse(vec3 n, vec3 l, float w) {
  return max((dot(n, l) + w) / (1.0 + w), 0.0);
}

vec3 rimLight(vec3 n, float ndv) {
  float edge = pow(1.0 - ndv, 2.2);
  float a = smoothstep(-0.25, 0.75, dot(n, uRimDirA));
  float b = smoothstep(-0.25, 0.75, dot(n, uRimDirB));
  return edge * (uRimColorA * a + uRimColorB * b);
}
`

export const FUR_VERTEX = /* glsl */ `
${COMMON_GLSL}
uniform float uShells;
uniform float uIsShell;
uniform float uFurLen;
uniform float uDeform;
uniform float uHasFace;
uniform vec4 uFace;
uniform vec3 uGravity;
uniform vec3 uInertia;

varying vec3 vBase;
varying vec3 vObjN;
varying vec3 vN;
varying vec3 vViewPos;
varying float vH;
varying float vClump;
varying float vLen;

float faceMask(vec3 p) {
  if (uHasFace < 0.5) return 1.0;
  vec2 q = vec2(p.x / uFace.y, (p.y - uFace.x) / uFace.z);
  float se = pow(pow(abs(q.x), uFace.w) + pow(abs(q.y), uFace.w), 1.0 / uFace.w);
  float front = smoothstep(0.0, 0.22, p.z);
  // Pelo corto que crece hacia afuera y un borde de capucha más mullido.
  float m = smoothstep(0.97, 1.16, se) * (1.0 + 0.32 * exp(-pow((se - 1.22) / 0.13, 2.0)));
  return mix(1.0, m, front);
}

void main() {
  float h = uIsShell > 0.5 ? (float(gl_InstanceID) + 1.0) / uShells : 0.0;
  vec3 n = normalize(normal);
  float clump = vnoise(position * 6.5 + 3.1);
  float mask = faceMask(position);
  float len = uFurLen * mask * (0.8 + 0.4 * clump);
  // Mechones: cada zona peina el pelo en una dirección levemente distinta.
  vec3 tuft = vec3(vnoise(position * 9.0), vnoise(position * 9.0 + 11.7), vnoise(position * 9.0 + 23.1)) - 0.5;
  tuft -= n * dot(tuft, n);
  vec3 p = position + n * (len * h);
  p += (uGravity + uInertia + tuft * 1.1) * (len * h * h);
  if (uDeform > 0.5) p = deformBody(p, n);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vBase = position;
  vObjN = normal;
  vN = normalize(normalMatrix * n);
  vViewPos = mv.xyz;
  vH = h;
  vClump = clump;
  vLen = mask;
  gl_Position = projectionMatrix * mv;
}
`

export const FUR_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
${LIGHT_GLSL}
uniform vec3 uTipColor;
uniform vec3 uRootColor;
uniform float uStrandFreq;
uniform float uIsShell;
uniform float uIri;
uniform float uSync;
uniform float uSoft;
uniform vec3 uOutward;
/** Dónde está la pieza dentro del cuerpo (brazos y pies: su hombro/tobillo). */
uniform vec3 uOrigin;
/** Encuadre «head»: el cuerpo se desvanece por debajo de esta altura (busto). */
uniform float uFadeY;

varying vec3 vBase;
varying vec3 vObjN;
varying vec3 vN;
varying vec3 vViewPos;
varying float vH;
varying float vClump;
varying float vLen;

// Hebra cónica en una celda 3D, medida en el plano tangente.
float strand(vec3 p, vec3 n, float h, float freq, float seed, float soft) {
  vec3 q = p * freq + seed;
  vec3 cell = floor(q);
  vec3 f = fract(q) - 0.5;
  float rnd = hash13(cell);
  float len = mix(0.45, 1.0, rnd);
  if (h > len) return 0.0;
  vec3 jitter = (vec3(hash13(cell + 7.1), hash13(cell + 3.7), hash13(cell + 1.3)) - 0.5) * 0.36;
  vec3 d = f - jitter;
  d -= n * dot(d, n);
  float r = 0.62 * (1.0 - pow(h / len, 1.6)) * (1.0 + soft * 0.35);
  return 1.0 - smoothstep(r * 0.35 * (1.0 - soft), r, length(d));
}

// Rotaciones fijas para que la rejilla de celdas no se alinee con los ejes (sin rayas).
const mat3 ROT_A = mat3(0.788, 0.346, -0.509, -0.214, 0.926, 0.311, 0.577, -0.153, 0.802);
const mat3 ROT_B = mat3(0.36, -0.48, 0.8, 0.8, 0.6, 0.0, -0.48, 0.64, 0.6);

void main() {
  float h = vH;
  float alpha = 1.0;
  if (uIsShell > 0.5) {
    if (vLen < 0.04) discard;
    vec3 on = normalize(vObjN);
    float s = max(
      strand(ROT_A * vBase, ROT_A * on, h, uStrandFreq, 0.0, uSoft),
      strand(ROT_B * vBase, ROT_B * on, h, uStrandFreq * 0.71, 17.3, uSoft)
    );
    alpha = s * (0.92 - h * 0.45) * (1.0 - uSoft * 0.25);
    if (alpha < 0.03) discard;
  }
  vec3 N = normalize(vN);
  vec3 V = normalize(-vViewPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float ao = mix(mix(0.66, 0.84, uSoft), 1.0, pow(h, 0.6));
  // Brazos: el lado pegado al cuerpo queda en sombra suave.
  float sideAO = dot(uOutward, uOutward) > 0.0 ? smoothstep(-0.7, 0.4, dot(normalize(vObjN), uOutward)) : 1.0;
  ao *= mix(0.68, 1.0, sideAO);
  // Posición en el cuerpo (no en la pieza): brazos y pies se iluminan igual que el cuerpo a su altura.
  vec3 bp = vBase + uOrigin;
  // Oclusión de piso: la base del peluche queda un poco más en sombra.
  ao *= mix(0.72, 1.0, smoothstep(0.05, 0.75, bp.y + bp.z * 0.3));
  vec3 albedo = mix(uRootColor, uTipColor, smoothstep(0.0, 0.85, h));
  albedo *= 0.93 + 0.14 * vClump;
  float key = wrapDiffuse(N, uKeyDir, 0.45);
  float fill = wrapDiffuse(N, uFillDir, 0.9);
  vec3 light = uAmbient + uKeyColor * key + uFillColor * fill;
  vec3 color = albedo * light * ao;
  float sheen = pow(1.0 - ndv, 2.0) * (0.25 + 0.75 * key);
  color += uKeyColor * albedo * sheen * 0.22 * h;
  color += rimLight(N, ndv) * (0.45 + 1.1 * h);
  float iriT = bp.y * 0.34 + dot(N, vec3(0.35, 0.22, 0.0)) * 0.5 - uTime * 0.07;
  color += iriPalette(iriT) * (pow(1.0 - ndv, 1.8) * 0.85 + 0.06) * uIri * (0.25 + h);
  float wavePos = fract(uTime * 0.42) * 3.1 - 0.45;
  float band = exp(-pow((bp.y - wavePos) / 0.22, 2.0));
  color += iriPalette(bp.y * 0.4 + uTime * 0.12) * band * uSync * (0.2 + 0.95 * h);
  alpha *= smoothstep(uFadeY, uFadeY + 0.55, bp.y);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`
