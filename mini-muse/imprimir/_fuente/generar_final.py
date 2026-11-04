"""Mini-Muse FINAL — fiel al dibujo, cara = pantalla, pelo modelado en la superficie.

Decisiones (aprobadas por el usuario hasta 2026-10-27):
  * Forma: malla aprobada con costados redondos (piezas/cuerpo_v3.ply) + brazos MANOPLA sueltos (v3/v4).
  * Escala 1.14 (≈34 cm): así la cara del dibujo (107×81 mm a 30 cm → 122×92 mm) aloja la pantalla
    MPI3508 (85.5×60.6) A RAS detrás de una ventana del tamaño del área activa (73.4×49).
  * Cara (P3) = bisel color crema con ventana; el vidrio de la pantalla queda a ras. Ganchos sujetan la pantalla.
  * Pelo: mechones modelados (relieve ≤ 1.3 mm, peinados hacia abajo) en cabeza, cuerpo y brazos;
    más "fuzzy skin" del slicer para la textura fina.
  * Cámara USB en el pecho (toma 15×15 para porta-lente M12 + agujero Ø9).
  * Brazos semi-macizos (modelo sólido; 3 paredes + 10 % gyroid en el slicer).

Unidades en metros. z arriba, −y = frente.
"""
import json, os
import numpy as np, trimesh
from trimesh.creation import box, cylinder
from scipy import ndimage as nd
from skimage.measure import marching_cubes

OUT = "imprimir/_fuente/stl_final"; os.makedirs(OUT, exist_ok=True)
S = 1.14
P = 0.0007
PARED = 0.0024
Z_UNION = 0.174 * S
CARA = dict(cz=0.226 * S, ax=0.063, az=0.048)        # óvalo de la cara: dibujo escalado (122×92) +3 % para que quepan las esquinas del módulo
Y_FRENTE = -0.0800                                   # frente de la cara (el domo original llega a −82.7)
PANT = dict(w=0.0855, h=0.0606, h_pcb=0.0560, grosor=0.006, act_w=0.0734, act_h=0.0490, off_act=0.0023)
# MPI3508 (lcdwiki): placa 85.5×56 tamaño Raspberry; HDMI, jack de audio y USB sobresalen 4.6 mm por el borde de ABAJO (total 60.6);
# conector de 26 pines atrás, por el borde de ARRIBA. Área visible 73.4×49 centrada en la placa.
PELO = dict(A1=0.0009, A2=0.0004, sig1=(1.3, 1.3, 4.5), sig2=(0.7, 0.7, 1.8), semilla=7)
X_CUERPO = 0.0765 * S                                # costado del cuerpo v5 a la altura del hombro
EJE_Y, EJE_Z = -0.002 * S, 0.164                      # eje del hombro más abajo: ahí el brazo ya es ancho (sin perillita)
X_FIN = X_CUERPO - PARED - 0.001                      # punta del tarugo (1 mm adentro de la pared)
X_TOP = X_FIN - 0.0045                                # cara superior del SG90
R_HORN = 0.0110                                       # horn simple recortado a 10.5 mm
CAM = dict(z=0.150 * S, lente_r=0.0053, toma=0.0150, prof=0.012)   # lente de 1 cm del usuario → agujero Ø10.6
ENG = "manifold"
rng = np.random.default_rng(PELO["semilla"])


def U(a, b): return a.union(b, engine=ENG)
def D(a, b): return a.difference(b, engine=ENG)
def I(a, b): return a.intersection(b, engine=ENG)


def caja(lo, hi):
    lo, hi = np.array(lo), np.array(hi)
    b = box(hi - lo); b.apply_translation((lo + hi) / 2); return b


def cil(r, p0, p1, n=48):
    return cylinder(radius=r, segment=[np.array(p0, float), np.array(p1, float)], sections=n)


def limpiar(t, minimo=0.02e-6):
    partes = [c for c in t.split(only_watertight=False) if abs(c.volume) > minimo]
    return trimesh.util.concatenate(partes) if len(partes) > 1 else partes[0]


def ruido_pelo(forma):
    """mechones: ruido gaussiano anisotrópico (alargado en z = peinado hacia abajo), 2 octavas, ≥ 0"""
    n1 = nd.gaussian_filter(rng.standard_normal(forma).astype(np.float32), PELO["sig1"])
    n2 = nd.gaussian_filter(rng.standard_normal(forma).astype(np.float32), PELO["sig2"])
    n1 /= n1.std(); n2 /= n2.std()
    return PELO["A1"] * (0.5 + 0.5 * np.tanh(1.6 * n1)) + PELO["A2"] * (0.5 + 0.5 * np.tanh(1.6 * n2))


def mc(campo, org, nivel=0.0):
    v, f, _, _ = marching_cubes(campo, nivel, spacing=(P, P, P))
    t = trimesh.Trimesh(v + org, f)
    t = max(t.split(only_watertight=False), key=lambda c: len(c.faces))
    if t.volume < 0: t.invert()
    return t


# ================= cuerpo + cabeza (SDF) =================
forma = trimesh.load("piezas/cuerpo_v5.ply"); forma.apply_scale(S)   # costados delgados bajo los brazos (como el dibujo)
vox = trimesh.voxel.creation.voxelize(forma, pitch=P).fill()
occ = np.pad(vox.matrix, 10); org = vox.transform[:3, 3] - 10 * P
sdf = ((nd.distance_transform_edt(~occ) - nd.distance_transform_edt(occ)) * P).astype(np.float32)
sdf = nd.gaussian_filter(sdf, 1.2)
X = (org[0] + np.arange(sdf.shape[0]) * P).astype(np.float32)
Y = (org[1] + np.arange(sdf.shape[1]) * P).astype(np.float32)
Z = (org[2] + np.arange(sdf.shape[2]) * P).astype(np.float32)

# máscara del pelo: sin pelo en la cara, en la unión cabeza/cuerpo, en la planta y alrededor de los hombros
GXf, GYf, GZf = X[:, None, None], Y[None, :, None], Z[None, None, :]
cara_m = (((GXf / (CARA["ax"] + 0.004)) ** 2 + ((GZf - CARA["cz"]) / (CARA["az"] + 0.004)) ** 2) < 1) & (GYf < -0.02)
union_m = np.abs(GZf - Z_UNION) < 0.004
planta_m = GZf < 0.004
hombro_m = (np.abs(GXf) > X_CUERPO - 0.01) & (((GYf - EJE_Y) ** 2 + (GZf - EJE_Z) ** 2) < 0.019 ** 2)
mascara = ~(cara_m | union_m | planta_m | hombro_m)
mascara = nd.gaussian_filter(mascara.astype(np.float32), 2.0)
sdf_pelo = sdf - ruido_pelo(sdf.shape) * mascara
del GXf, GYf, GZf, cara_m, union_m, planta_m, hombro_m

exterior = mc(sdf_pelo, org)            # piel con pelo
liso = mc(sdf, org)                     # forma lisa (para recortar soportes internos)
interior = mc(sdf, org, -PARED)
concha = D(exterior, interior)
print("concha con pelo lista", round(concha.volume * 1e6), "cm3")
GR = 0.6
bajo = caja((-GR, -GR, -0.01), (GR, GR, Z_UNION)); alto = caja((-GR, -GR, Z_UNION), (GR, GR, 0.5))

# ----- P2 cuerpo -----
cuerpo = I(concha, bajo)
lab_ext = mc(sdf, org, -PARED - 0.0005); lab_int = mc(sdf, org, -PARED - 0.0025)
labio = I(D(lab_ext, lab_int), caja((-GR, -GR, Z_UNION - 0.0005), (GR, GR, Z_UNION + 0.008)))
labio = U(labio, I(D(mc(sdf, org, -PARED + 0.0008), lab_int), caja((-GR, -GR, Z_UNION - 0.005), (GR, GR, Z_UNION))))
labio = D(labio, caja((-0.085, -GR, Z_UNION - 0.01), (0.085, -0.028, Z_UNION + 0.02)))
cuerpo = U(cuerpo, labio)

PI_C = np.array([0.0, 0.004 * S, 0.103 * S]); PI_BAJO = PI_C[2] - 0.0125; z_rep = PI_BAJO - 0.0045
repisa = I(caja((-GR, -GR, z_rep - 0.0024), (GR, GR, z_rep)), interior)
repisa = D(repisa, cil(0.026, (0, -0.006, z_rep - 0.01), (0, -0.006, z_rep + 0.01)))
for dx in (-0.03, 0.03):
    repisa = D(repisa, caja((dx - 0.006, 0.030, z_rep - 0.01), (dx + 0.006, 0.050, z_rep + 0.01)))
cuerpo = U(cuerpo, repisa)
for a in (0, 0.058):
    for b in (0, 0.049):
        x, y = -0.0425 + 0.0035 + a, PI_C[1] - 0.028 + 0.0035 + b
        cuerpo = U(cuerpo, cil(0.003, (x, y, z_rep - 0.001), (x, y, PI_BAJO)))
        cuerpo = D(cuerpo, cil(0.0011, (x, y, z_rep - 0.003), (x, y, PI_BAJO + 0.001)))

for s in (1, -1):                                   # cunas SG90 (placa con ventana + nervios fuera del horn)
    zc = EJE_Z - 0.0058; x_or = X_TOP - 0.0068        # orejas del SG90: su cara inferior a 6.8 mm de la cara superior (hoja técnica)
    lo, hi = sorted((s * (x_or - 0.0030), s * x_or))
    placa = caja((lo, EJE_Y - 0.020, zc - 0.0205), (hi, EJE_Y + 0.020, zc + 0.0205))
    for sy in (1, -1):
        y0, y1 = sorted((EJE_Y + sy * (R_HORN + 0.001), EJE_Y + sy * (R_HORN + 0.0045)))
        lo2, hi2 = sorted((s * (x_or - 0.0030), s * 0.12))
        placa = U(placa, caja((lo2, y0, zc - 0.0205), (hi2, y1, zc + 0.0205)))
    placa = I(placa, liso)
    placa = D(placa, caja((lo - 0.001, EJE_Y - 0.0064, zc - 0.0116), (hi + 0.001, EJE_Y + 0.0064, zc + 0.0116)))
    for sz in (1, -1):
        placa = D(placa, cil(0.0008, (lo - 0.002, EJE_Y, zc + sz * 0.0139), (hi + 0.002, EJE_Y, zc + sz * 0.0139)))
    cuerpo = U(cuerpo, placa)
    cuerpo = D(cuerpo, cil(0.0118, (s * (X_TOP + 0.0005), EJE_Y, EJE_Z), (s * 0.14, EJE_Y, EJE_Z)))   # agujero Ø23.6 (tarugo Ø22)
    cuerpo = D(cuerpo, cil(R_HORN + 0.0005, (s * (X_TOP + 0.0003), EJE_Y, EJE_Z), (s * (X_TOP + 0.0045), EJE_Y, EJE_Z)))

z_entre = float(liso.ray.intersects_location([[0, -0.006, -0.1]], [[0, 0, 1]])[0][:, 2].min())   # entrepierna
for r, n in ((0, 1), (0.008, 6), (0.016, 12)):                 # rejilla del parlante (mira hacia abajo)
    for k in range(n):
        a = 2 * np.pi * k / n
        cuerpo = D(cuerpo, cil(0.0015, (r * np.cos(a), -0.006 + r * np.sin(a), z_entre - 0.015), (r * np.cos(a), -0.006 + r * np.sin(a), z_entre + 0.015)))
Z_PARL = 0.0456                                                 # base del parlante (cabe con 2.8 mm de pared)
aro = D(I(caja((-GR, -GR, Z_PARL - 0.002), (GR, GR, Z_PARL)), interior), cil(0.018, (0, -0.006, Z_PARL - 0.01), (0, -0.006, Z_PARL + 0.01)))
aro = U(aro, D(cil(0.0228, (0, -0.006, Z_PARL - 0.001), (0, -0.006, Z_PARL + 0.006)), cil(0.0204, (0, -0.006, Z_PARL - 0.01), (0, -0.006, Z_PARL + 0.02))))
cuerpo = U(cuerpo, I(aro, liso))
cuerpo = D(cuerpo, cil(0.006, (0, 0.03, PI_C[2] - 0.003), (0, 0.15, PI_C[2] - 0.003)))   # cable de poder
for k in range(-3, 4):                                          # ventilación + oído del micrófono USB
    cuerpo = D(cuerpo, caja((k * 0.010 - 0.002, 0.03, PI_C[2] + 0.022), (k * 0.010 + 0.002, 0.15, PI_C[2] + 0.047)))
# bandeja universal del amplificador (48×52 mm) entre el parlante y la Pi, con 2 ranuras para zuncho
Z_AMP = 0.072
bandeja = I(caja((-0.024, 0.016, Z_AMP - 0.0024), (0.024, 0.09, Z_AMP)), interior)
for sx in (-1, 1):
    bandeja = D(bandeja, caja((sx * 0.019 - 0.0015, 0.024, Z_AMP - 0.01), (sx * 0.019 + 0.0015, 0.030, Z_AMP + 0.01)))
    bandeja = D(bandeja, caja((sx * 0.019 - 0.0015, 0.050, Z_AMP - 0.01), (sx * 0.019 + 0.0015, 0.056, Z_AMP + 0.01)))
cuerpo = U(cuerpo, bandeja)
y_pecho = float(liso.ray.intersects_location([[0, -0.3, CAM["z"]]], [[0, 1, 0]])[0][:, 1].min())
toma = D(caja((-CAM["toma"] / 2 - 0.002, y_pecho + PARED - 0.0005, CAM["z"] - CAM["toma"] / 2 - 0.002),
              (CAM["toma"] / 2 + 0.002, y_pecho + PARED + CAM["prof"], CAM["z"] + CAM["toma"] / 2 + 0.002)),
         caja((-CAM["toma"] / 2, y_pecho - 0.01, CAM["z"] - CAM["toma"] / 2), (CAM["toma"] / 2, y_pecho + 0.05, CAM["z"] + CAM["toma"] / 2)))
cuerpo = U(cuerpo, I(toma, liso))
cuerpo = D(cuerpo, cil(CAM["lente_r"], (0, y_pecho - 0.01, CAM["z"]), (0, y_pecho + 0.01, CAM["z"])))
cuerpo = limpiar(cuerpo); cuerpo.export(f"{OUT}/P2_cuerpo.stl"); print("P2 listo")

# ----- P1 cabeza -----
def elipse_y(ax, az, y0, y1, cz=CARA["cz"]):
    c = cylinder(radius=1.0, height=abs(y1 - y0), sections=128)
    c.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    c.apply_scale([ax, 1, az]); c.apply_translation([0, (y0 + y1) / 2, cz]); return c


cabeza = I(concha, alto)
hueco = elipse_y(CARA["ax"], CARA["az"], -0.14, -0.02)
pestana = I(D(elipse_y(CARA["ax"] + 0.005, CARA["az"] + 0.005, -0.14, -0.02), hueco), D(interior, mc(sdf, org, -PARED - 0.0024)))
pestana = I(pestana, caja((-GR, -GR, Z_UNION + 0.0005), (GR, GR, 0.5)))
cabeza = limpiar(U(D(cabeza, hueco), pestana)); cabeza.export(f"{OUT}/P1_cabeza.stl"); print("P1 listo")


# ----- P3 cara: DOMO original del dibujo + aplanado solo donde va la pantalla (vidrio a ras) -----
from scipy.ndimage import map_coordinates


def cara_domo(holgura=0.0003, t=0.0012, y_atras=-0.040, paso=0.00035, k=0.024):
    ax, az, cz = CARA["ax"] - holgura, CARA["az"] - holgura, CARA["cz"]
    xs = np.arange(-ax - 0.002, ax + 0.002, paso); ys = np.arange(Y_FRENTE - 0.012, y_atras + 0.003, paso)
    zs = np.arange(cz - az - 0.002, cz + az + 0.002, paso)
    GX, GY, GZ = np.meshgrid(xs, ys, zs, indexing="ij")
    idx = [(G - o) / P for G, o in zip((GX, GY, GZ), org)]
    domo = map_coordinates(sdf, idx, order=1, mode="nearest").astype(np.float32)        # superficie original
    # envolvente de la pantalla: caja redondeada que cubre el módulo (85.5×60.6) con pared de 1.2 mm
    czm = cz - PANT["off_act"]; yv = Y_FRENTE                                            # frente del vidrio = Y_FRENTE + t
    rr = 0.012; hx, hz = PANT["w"] / 2 + t + 0.0004 + rr * 0.6, PANT["h"] / 2 + t + 0.0004 + rr * 0.6   # cojín suave
    hy = (y_atras - yv) / 2; yc = (y_atras + yv) / 2
    qx, qy, qz = np.abs(GX) - hx + rr, np.abs(GY - yc) - hy + rr, np.abs(GZ - czm) - hz + rr
    cajad = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2) + np.minimum(np.maximum(np.maximum(qx, qy), qz), 0) - rr
    h = np.clip(0.5 + 0.5 * (cajad - domo) / k, 0, 1)
    ext = cajad * (1 - h) + domo * h - k * h * (1 - h)                                  # unión suave domo ∪ caja
    borde = (np.sqrt((GX / ax) ** 2 + ((GZ - cz) / az) ** 2) - 1) * min(ax, az)         # recorte al óvalo de la cara
    ext = np.maximum(ext, borde)
    campo = np.maximum(np.maximum(ext, -(ext + t)), GY - (y_atras - 0.0032))
    campo = np.maximum(campo, borde)
    v, f, _, _ = marching_cubes(campo, 1e-6, spacing=(paso,) * 3)
    m = max(trimesh.Trimesh(v + np.array([xs[0], ys[0], zs[0]]), f).split(only_watertight=False), key=lambda c: len(c.faces))
    if m.volume < 0: m.invert()
    aw, ah, r = PANT["act_w"] / 2, PANT["act_h"] / 2, 0.006
    ventana = U(caja((-aw + r, Y_FRENTE - 0.03, cz - ah), (aw - r, Y_FRENTE + 0.0005, cz + ah)),
                caja((-aw, Y_FRENTE - 0.03, cz - ah + r), (aw, Y_FRENTE + 0.0005, cz + ah - r)))
    for sx in (-1, 1):
        for sz in (-1, 1):
            ventana = U(ventana, cil(r, (sx * (aw - r), Y_FRENTE - 0.03, cz + sz * (ah - r)), (sx * (aw - r), Y_FRENTE + 0.0005, cz + sz * (ah - r))))
    m = D(m, ventana)
    # hueco del módulo detrás del vidrio (por si el domo invade el volumen de la pantalla)
    m = D(m, caja((-PANT["w"] / 2 - 0.0004, Y_FRENTE + t, czm - PANT["h"] / 2 - 0.0004), (PANT["w"] / 2 + 0.0004, y_atras + 0.01, czm + PANT["h"] / 2 + 0.0004)))
    yf = Y_FRENTE + t; w2, h2, T = PANT["w"] / 2, PANT["h"] / 2, PANT["grosor"]
    for sx in (-1, 1):
        x0 = sx * (w2 + 0.0004)
        m = U(m, caja((min(x0, x0 + sx * 0.0015), yf - 0.0003, czm - 0.010), (max(x0, x0 + sx * 0.0015), yf + T, czm + 0.010)))
    # ganchos al borde de la PLACA (56 mm), entre los conectores: abajo libres de USB/HDMI/jack, arriba fuera del de 26 pines
    for sz, xs_g in ((1, (0.022, 0.036)), (-1, (-0.023, 0.024))):
        for xx in xs_g:
            zb = cz + sz * (PANT["h_pcb"] / 2 + 0.0003)
            m = U(m, caja((xx - 0.003, yf - 0.0003, min(zb, zb + sz * 0.002)), (xx + 0.003, yf + T + 0.0015, max(zb, zb + sz * 0.002))))
            m = U(m, caja((xx - 0.003, yf + T, min(zb, zb - sz * 0.0012)), (xx + 0.003, yf + T + 0.0015, max(zb, zb - sz * 0.0012))))
    return limpiar(m)


cara = cara_domo(); cara.export(f"{OUT}/P3_cara.stl"); print("P3 listo")

# ================= P4 / P5 brazos manopla (semi-macizos) con pelo =================
def brazo(s):
    lo = np.array([s * 0.107 * S - 0.045, -0.072, 0.05 * S]); hi = np.array([s * 0.107 * S + 0.045, 0.072, 0.20 * S])
    lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
    xs, ys, zs = [np.arange(a, b, P, dtype=np.float32) for a, b in zip(lo, hi)]
    GX, GY, GZ = np.meshgrid(xs, ys, zs, indexing="ij")

    def ell(c, r):
        return (np.sqrt(((GX - c[0]) / r[0]) ** 2 + ((GY - c[1]) / r[1]) ** 2 + ((GZ - c[2]) / r[2]) ** 2) - 1) * min(r)
    a = ell((s * 0.107 * S, -0.002 * S, 0.135 * S), (0.019 * S, 0.036 * S, 0.042 * S))
    b = ell((s * 0.109 * S, -0.008 * S, 0.093 * S), (0.021 * S, 0.041 * S, 0.028 * S))
    k = 0.022 * S; h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    campo = b * (1 - h) + a * h - k * h * (1 - h)
    lisa = campo.copy()
    sin_pelo = (s * GX < X_CUERPO + 0.012) & (((GY - EJE_Y) ** 2 + (GZ - EJE_Z) ** 2) < 0.016 ** 2)   # asiento del tarugo
    mask = nd.gaussian_filter((~sin_pelo).astype(np.float32), 2.0)
    campo = campo - ruido_pelo(campo.shape) * mask
    org_b = np.array([xs[0], ys[0], zs[0]])
    ext = mc(campo, org_b); ext_liso = mc(lisa, org_b)
    x_in = ext_liso.vertices[:, 0].min() if s > 0 else -ext_liso.vertices[:, 0].max()
    x_seat = x_in + 0.0015
    seat = caja((s * x_seat if s > 0 else -GR, -GR, -GR), (GR if s > 0 else s * x_seat, GR, GR))
    m = I(ext, seat)
    m = U(m, cil(0.010, (s * X_FIN, EJE_Y, EJE_Z), (s * (x_seat + 0.004), EJE_Y, EJE_Z)))   # tarugo Ø20
    hx0, hx1 = sorted((s * X_FIN, s * (X_FIN + 0.0022)))
    m = D(m, caja((hx0, EJE_Y - 0.0031, EJE_Z - 0.0055 - 0.00975), (hx1, EJE_Y + 0.0031, EJE_Z - 0.0055 + 0.00975)))
    m = D(m, cil(0.0038, (s * X_FIN, EJE_Y, EJE_Z), (s * (X_FIN + 0.0025), EJE_Y, EJE_Z)))
    m = D(m, cil(0.0035, (s * (X_FIN + 0.002), EJE_Y, EJE_Z), (s * 0.20, EJE_Y, EJE_Z)))      # acceso tornillo central
    for dd in (0.0085, 0.0135):
        m = D(m, cil(0.0008, (s * X_FIN, EJE_Y, EJE_Z - dd), (s * (X_FIN + 0.008), EJE_Y, EJE_Z - dd)))
    return limpiar(m), x_in


info = {}
for nombre, s in (("P4_brazo_derecho", 1), ("P5_brazo_izquierdo", -1)):
    m, x_in = brazo(s); m.export(f"{OUT}/{nombre}.stl")
    info[nombre] = {"x_interior_mm": round(x_in * 1000, 1), "volumen_cm3": round(abs(m.volume) * 1e6, 1)}
    print(nombre, info[nombre])
tapon = U(cil(0.00345, (0, 0, 0), (0, 0, 0.004)), cil(0.0045, (0, 0, 0.004), (0, 0, 0.005)))
tapon.export(f"{OUT}/P6_tapon_brazo_x2.stl")

prueba = I(cuerpo, caja((X_TOP - 0.03, EJE_Y - 0.030, EJE_Z - 0.035), (0.14, EJE_Y + 0.030, EJE_Z + 0.030)))
limpiar(prueba).export(f"{OUT}/P0_prueba_hombro.stl")

rep = {"_param": {"S": S, "X_TOP": X_TOP, "X_FIN": X_FIN, "EJE": [X_CUERPO, EJE_Y, EJE_Z], "Z_UNION": Z_UNION,
                  "CARA": CARA, "Y_FRENTE": Y_FRENTE, "PANT": PANT, "CAM_z": CAM["z"], "y_pecho": y_pecho,
                  "PI_C": PI_C.tolist(), "z_entre": z_entre, "Z_PARL": Z_PARL, "CAM_prof": CAM["prof"], "Z_AMP": Z_AMP}, "_brazos": info}
for f in sorted(os.listdir(OUT)):
    if not f.endswith(".stl"): continue
    t = trimesh.load(f"{OUT}/{f}"); e = (t.extents * 1000).round(1)
    rep[f] = {"mm": e.tolist(), "cabe_cama_256": bool((np.sort(e) <= 255).all()), "volumen_cm3": round(abs(t.volume) * 1e6, 1)}
json.dump(rep, open("imprimir/_fuente/reporte_final.json", "w"), indent=1)
print(json.dumps(rep, indent=1))
