"""Brazos FINALES: forma copiada del dibujo + unión al servo reforzada.

FORMA (feedback: "las nuestras están muy redondas, que sean idénticas a las de la foto"):
  rebanada por rebanada (cada 1.5 mm de alto) el brazo es una elipse cuyo
    · contorno exterior de frente = silueta de la foto de frente (modelo_ia/frente.png),
    · borde interior = costado del cuerpo + holgura (para que gire sin rozar),
    · fondo (adelante/atrás) = el que tiene el brazo en la malla aprobada a esa altura.
  Así sale angosto en el hombro, más ancho en la mano (a 2/3 de la altura) y con la mano curvada hacia la panza.

UNIÓN (feedback: "el tarugo queda con una pizca de unión, se revienta"):
  · eje MACIZO Ø22 que atraviesa todo el brazo, fundido a las paredes interior y exterior con filete;
  · tarugo Ø22 que entra al cuerpo (agujero Ø23.6), fundido al costado del brazo con filete;
  · resto del brazo hueco (pared 2.0 mm) → liviano sin depender del relleno.
  · horn simple RECORTADO a 10.5 mm (cabe entero en el tarugo): 1 tornillo + tornillo central + gota de epóxica.
Imprimir de pie (mano abajo): las capas corren a lo largo del tarugo.
"""
import json, sys, numpy as np, trimesh, manifold3d as m3
from PIL import Image
from scipy import ndimage as nd
from skimage.measure import marching_cubes
from trimesh.creation import box, cylinder

OUT = "imprimir/_fuente/stl_final"
S = 1.14; H30 = 0.30
R = json.load(open("imprimir/_fuente/reporte_final.json"))["_param"]
EJE_Y, EJE_Z = R["EJE"][1], R["EJE"][2]
X_FIN = R["X_FIN"]
X_IN = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0815 * S     # borde interior del brazo (holgura con cuerpo y cabeza)
P = 0.0005
PARED = 0.0012                      # 3 perímetros de 0.4
R_EJE = 0.011
PELO = dict(A1=0.0009, A2=0.0004, sig1=(1.8, 1.8, 6.3), sig2=(1.0, 1.0, 2.5))
rng = np.random.default_rng(11)

# ---------- perfil de la foto (fracción de la altura) ----------
mask = np.asarray(Image.open("imprimir/_fuente/fidelidad/mascara_frente.png")) > 127
ys, xs = np.nonzero(mask); top, bot = ys.min(), ys.max(); Hp = bot - top; cx = (xs.min() + xs.max()) / 2


def x_fuera(f):
    fila = np.nonzero(mask[int(top + f * Hp)])[0]
    return ((fila.max() - cx) + (cx - fila.min())) / 2 / Hp          # promedio izq/der, en fracción de alto


malla = trimesh.load("modelo_ia/muse_30cm.ply")
perfil = []
for f in np.arange(0.375, 0.772, 0.003):
    z30 = (1 - f) * H30; xo = x_fuera(f) * H30 * S
    xi = X_IN
    if xo - xi < 0.016:                                               # sin puntica arriba: el hombro arranca ya redondo
        continue
    xc = (xo + xi) / 2
    sec = malla.section([0, 0, 1], [0, 0, z30])
    V = sec.vertices if sec is not None else np.zeros((0, 3))
    V = V[V[:, 0] > xc / S - 0.002]
    if len(V) < 5:
        continue
    y0, y1 = V[:, 1].min() * S, V[:, 1].max() * S
    if f < 0.465:                                                     # el brazo arranca debajo del hombro del cuerpo
        continue
    w = (xo - xi) / 2
    # mano (desde ~60 % de la altura): recupera el largo hacia ADELANTE de la malla (palma/bola como en el dibujo);
    # brazo de arriba: sección redonda (sin aleta)
    t = float(np.clip((f - 0.58) / 0.10, 0, 1)); t = t * t * (3 - 2 * t)
    d_red = max(1.15 * w + 0.004, 0.015 * S)                         # brazo de arriba: banda pareja de ~34 mm de grueso
    d_mano = (y1 - y0) / 2 * 0.96
    Vb = V[V[:, 0] > (xo / S) - 0.012]
    yc_red = (Vb[:, 1].min() + Vb[:, 1].max()) / 2 * S if len(Vb) > 3 else (y0 + y1) / 2
    d = min(d_mano, d_red) * (1 - t) + min(d_mano, 1.9 * w + 0.004) * t
    yc = yc_red * (1 - t) + ((y0 + y1) / 2) * t
    perfil.append((z30 * S, xc, w, yc, d))
perfil = np.array(perfil)[::-1]                                       # z ascendente
# la mano termina donde todavía es ancha: se quitan las rebanadas finitas de abajo (hacían una "bolita")
wmax = perfil[:, 2].max(); k0 = 0
while k0 < len(perfil) - 1 and perfil[k0, 2] < 0.72 * wmax and perfil[k0, 0] < perfil[np.argmax(perfil[:, 2]), 0]:
    k0 += 1
perfil = perfil[k0:]
# cierres continuos (sin pliegue): la sección se encoge en cuarto de elipse arriba y abajo
def cierre(fila, signo, n=14):
    z, xc_, w_, yc_, d_ = fila; h = (0.85 if signo < 0 else 1.4) * min(w_, d_); out = []   # arriba: cierre largo y suave
    for k in range(1, n + 1):
        fac = max(np.sqrt(1 - (k / n) ** 2), 0.05)
        out.append((z + signo * h * k / n, xc_, w_ * fac, yc_, d_ * fac))
    return out
abajo = cierre(perfil[0], -1)[::-1]; arriba = cierre(perfil[-1], +1, n=18)
perfil = np.vstack([np.array(abajo), perfil, np.array(arriba)])
print("rebanadas:", len(perfil), " z", perfil[0, 0].round(3), "→", perfil[-1, 0].round(3))


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1); return b * (1 - h) + a * h - k * h * (1 - h)


def M(t):
    me = m3.Mesh(vert_properties=np.asarray(t.vertices, np.float32), tri_verts=np.asarray(t.faces, np.uint32))
    me.merge(); return m3.Manifold(me)


def T(man):
    me = man.to_mesh(); return trimesh.Trimesh(np.asarray(me.vert_properties)[:, :3], np.asarray(me.tri_verts))


def caja(lo, hi):
    lo, hi = np.array(lo), np.array(hi); b = box(hi - lo); b.apply_translation((lo + hi) / 2); return M(b)


def cil(r, p0, p1, n=64):
    return M(cylinder(radius=r, segment=[np.array(p0, float), np.array(p1, float)], sections=n))


def brazo(s):
    zmin, zmax = perfil[0, 0] - 0.035, perfil[-1, 0] + 0.03
    xlo, xhi = (X_FIN - 0.004, perfil[:, 1].max() + perfil[:, 2].max() + 0.008)
    lo = np.array([xlo, perfil[:, 3].min() - perfil[:, 4].max() - 0.008, zmin])
    hi = np.array([xhi, perfil[:, 3].max() + perfil[:, 4].max() + 0.008, zmax])
    xs_, ys_, zs_ = [np.arange(a, b, P, dtype=np.float32) for a, b in zip(lo, hi)]
    GX, GY, GZ = np.meshgrid(xs_, ys_, zs_, indexing="ij")
    # parámetros de cada rebanada interpolados en z
    zc = perfil[:, 0]
    XC = np.interp(zs_, zc, perfil[:, 1])[None, None, :]; W = np.interp(zs_, zc, perfil[:, 2])[None, None, :]
    YC = np.interp(zs_, zc, perfil[:, 3])[None, None, :]; DD = np.interp(zs_, zc, perfil[:, 4])[None, None, :]
    q = np.sqrt(((GX - XC) / W) ** 2 + ((GY - YC) / DD) ** 2)
    lado = (q - 1) * np.minimum(W, DD)
    liso = np.where((GZ < perfil[0, 0]) | (GZ > perfil[-1, 0]), 0.05, lado).astype(np.float32)
    liso = nd.gaussian_filter(liso, 2.0)                                  # suaviza el escalonado entre rebanadas
    rad = np.sqrt((GY - EJE_Y) ** 2 + (GZ - EJE_Z) ** 2)
    n1 = nd.gaussian_filter(rng.standard_normal(liso.shape).astype(np.float32), PELO["sig1"]); n1 /= n1.std()
    n2 = nd.gaussian_filter(rng.standard_normal(liso.shape).astype(np.float32), PELO["sig2"]); n2 /= n2.std()
    pelo = PELO["A1"] * (0.5 + 0.5 * np.tanh(1.6 * n1)) + PELO["A2"] * (0.5 + 0.5 * np.tanh(1.6 * n2))
    msk = nd.gaussian_filter(((rad > 0.016) | (GX > X_IN + 0.02)).astype(np.float32), 3.0)
    piel = liso - pelo * msk
    concha = np.maximum(piel, -(liso + PARED))
    eje = np.maximum(rad - R_EJE, liso)                                   # eje macizo dentro del brazo
    campo = smin(concha, eje, 0.004)
    tarugo = np.maximum(rad - R_EJE, np.maximum(X_FIN - GX, GX - (X_IN + 0.015)))
    campo = smin(campo, tarugo, 0.003)
    v, f, _, _ = marching_cubes(campo, 1e-6, spacing=(P, P, P))
    t = trimesh.Trimesh(v + lo, f)
    partes = [c for c in t.split(only_watertight=False) if len(c.faces) > 2000]
    man = M(trimesh.util.concatenate(partes))
    man = man - caja((X_FIN - 0.05, -0.3, -0.3), (X_FIN, 0.3, 0.6))      # punta del tarugo plana
    # horn simple recortado a 10.5 mm: bolsillo 2.2 mm + cubo + 1 tornillo a 8.5 mm + tornillo central
    man = man - caja((X_FIN, EJE_Y - 0.0031, EJE_Z - 0.0105), (X_FIN + 0.0022, EJE_Y + 0.0031, EJE_Z + 0.0040))
    man = man - cil(0.0038, (X_FIN, EJE_Y, EJE_Z), (X_FIN + 0.0025, EJE_Y, EJE_Z))
    man = man - cil(0.0008, (X_FIN, EJE_Y, EJE_Z - 0.0085), (X_FIN + 0.008, EJE_Y, EJE_Z - 0.0085))
    man = man - cil(0.0018, (X_FIN + 0.002, EJE_Y, EJE_Z), (0.30, EJE_Y, EJE_Z))
    man = man - cil(0.0060, (X_IN + 0.014, EJE_Y, EJE_Z), (0.30, EJE_Y, EJE_Z))   # eje hueco Ø12 (paredes 5 mm) = acceso del destornillador
    if s < 0:
        man = man.mirror([1, 0, 0])
    return T(man)


info = {}
for nombre, s in (("P4_brazo_derecho", 1), ("P5_brazo_izquierdo", -1)):
    m = brazo(s); m.export(f"{OUT}/{nombre}.stl")
    com = m.center_mass; r = float(np.hypot(com[1] - EJE_Y, com[2] - EJE_Z)); masa = abs(m.volume) * 1240
    info[nombre] = {"masa_g": round(masa * 1000, 1), "palanca_mm": round(r * 1000, 1),
                    "par_kgcm": round(masa * 9.81 * r / 0.0980665, 2), "mm": (m.extents * 1000).round(1).tolist(),
                    "volumen_ok": bool(m.is_volume)}
    print(nombre, info[nombre])
json.dump({"X_IN": X_IN, "R_EJE": R_EJE, **info}, open("imprimir/_fuente/brazos_final.json", "w"), indent=1)
