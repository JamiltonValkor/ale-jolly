"""v2: bracitos como piezas INDIVIDUALES redondeadas (sin corte plano) y cuerpo redondo debajo.

1. Voxeliza la malla fiel (1 mm).
2. Cuerpo: quita la zona de los brazos y rehace el costado de la panza rebanada por rebanada
   con una elipse ajustada a la curva del cuerpo (como en las fotos, la panza es redonda bajo el brazo).
3. Brazo: la mitad exterior (la que se ve en las fotos) se refleja hacia adentro → manopla redonda.
4. Se separa el brazo del cuerpo con una holgura y se busca el eje del hombro (gira hacia adelante, eje x).
"""
import json
import numpy as np, trimesh
from scipy import ndimage as nd
from skimage.measure import marching_cubes

P = 0.001
XC = 0.088            # donde empieza el brazo en la malla original
HOLGURA = 0.004       # aire entre brazo y cuerpo

m = trimesh.load("modelo_ia/muse_30cm.ply")
vox = trimesh.voxel.creation.voxelize(m, pitch=P).fill()
occ = vox.matrix.copy()
org = vox.transform[:3, 3]                       # centro del voxel [0,0,0]
X = org[0] + np.arange(occ.shape[0]) * P
Y = org[1] + np.arange(occ.shape[1]) * P
Z = org[2] + np.arange(occ.shape[2]) * P
ix_lo, ix_hi = np.searchsorted(X, -XC), np.searchsorted(X, XC)


def a_malla(o, nombre, sigma=1.2):
    f = nd.gaussian_filter(o.astype(np.float32), sigma)
    v, fc, _, _ = marching_cubes(np.pad(f, 2), 0.5)
    v = (v - 2) * P + org
    t = trimesh.Trimesh(v, fc[:, ::-1]); t.merge_vertices(); t.fix_normals()
    trimesh.smoothing.filter_taubin(t, iterations=8)
    t = max(t.split(only_watertight=False), key=lambda c: len(c.faces))
    t.export(f"piezas/{nombre}.ply")
    return t


# ---------- cuerpo con la panza redonda bajo el brazo ----------
cuerpo = occ.copy()
cuerpo[:ix_lo] = False; cuerpo[ix_hi:] = False
X72 = 0.072
for k in range(occ.shape[2]):
    sl = cuerpo[:, :, k]
    if not (sl[ix_hi - 1].any() or sl[ix_lo].any()):
        continue                                   # esta altura no tocaba el brazo
    pts = np.argwhere(sl)
    xs, ys = X[pts[:, 0]], Y[pts[:, 1]]
    nuevo = sl.copy()
    for lado in (1, -1):
        banda = (lado * xs > 0.040) & (lado * xs < X72)
        if banda.sum() < 50:
            continue
        # borde del cuerpo en la banda: y mínimo y máximo por columna x
        cols = {}
        for x, y in zip(xs[banda], ys[banda]):
            lo, hi = cols.get(x, (y, y)); cols[x] = (min(lo, y), max(hi, y))
        xx = np.array(sorted(cols)); lo = np.array([cols[x][0] for x in xx]); hi = np.array([cols[x][1] for x in xx])
        yc = np.median((lo + hi) / 2); bb = np.max((hi - lo) / 2)
        # elipse centrada en x=0: (x/a)^2 + ((y-yc)/b)^2 = 1  → a desde el semiancho medido en la banda
        sem = (hi - lo) / 2
        a_est = np.median(np.abs(xx) / np.sqrt(np.clip(1 - (sem / bb) ** 2, 1e-3, 1)))
        a_est = min(a_est, XC - 0.002)
        GX, GY = np.meshgrid(X, Y, indexing="ij")
        elip = (GX / a_est) ** 2 + ((GY - yc) / bb) ** 2 <= 1
        zona = (lado * GX >= X72)
        nuevo = np.where(zona, elip & (lado * GX < XC), nuevo)
    cuerpo[:, :, k] = nuevo
cuerpo = nd.binary_closing(cuerpo, iterations=2)
t_cuerpo = a_malla(cuerpo, "cuerpo_v2", sigma=1.6)

# ---------- brazos redondos ----------
info = {}
for nombre, lado in (("brazo_der", 1), ("brazo_izq", -1)):
    b = occ.copy()
    if lado > 0: b[:ix_hi] = False
    else: b[ix_lo:] = False
    lab, n = nd.label(b); b = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
    idx = np.argwhere(b); xs = X[idx[:, 0]]
    x_ext = xs.max() if lado > 0 else xs.min()
    x_mid = (XC + x_ext) / 2 if lado > 0 else (-XC + x_ext) / 2
    # reflejar la mitad exterior hacia adentro (manopla simétrica, redonda por ambos lados)
    ext = b & ((X[:, None, None] - x_mid) * lado >= 0)
    ref = np.zeros_like(b)
    ii = np.argwhere(ext)
    xr = 2 * x_mid - X[ii[:, 0]]
    jr = np.clip(np.round((xr - org[0]) / P).astype(int), 0, b.shape[0] - 1)
    ref[jr, ii[:, 1], ii[:, 2]] = True
    brazo = nd.binary_closing(ext | ref, iterations=2)
    # alejarlo del cuerpo: correr hacia afuera hasta tener HOLGURA en todo el recorrido
    paso = 0
    while True:
        desplaz = np.roll(brazo, lado * paso, axis=0)
        # recorrido: gira alrededor de x → la holgura en x se mantiene; basta revisar el contorno en x por fila (y,z)
        if lado > 0:
            x_in_brazo = X[np.argmax(desplaz, axis=0)][desplaz.any(axis=0)].min()
            x_out_cuerpo = X[cuerpo.shape[0] - 1 - np.argmax(cuerpo[::-1], axis=0)][cuerpo.any(axis=0)].max()
        else:
            x_in_brazo = -X[desplaz.shape[0] - 1 - np.argmax(desplaz[::-1], axis=0)][desplaz.any(axis=0)].max()
            x_out_cuerpo = -X[np.argmax(cuerpo, axis=0)][cuerpo.any(axis=0)].min()
        if x_in_brazo - x_out_cuerpo >= HOLGURA or paso > 40:
            break
        paso += 1
    t = a_malla(desplaz, nombre, sigma=1.4)
    # eje del hombro: 25 mm bajo la punta superior del brazo, centrado en y
    v = t.vertices; ztop = v[:, 2].max(); z0 = ztop - 0.025
    band = v[np.abs(v[:, 2] - z0) < 0.003]
    info[nombre] = {"corrido_mm": paso, "holgura_mm": round((x_in_brazo - x_out_cuerpo) * 1000, 1),
                    "eje": [round(float(lado * (x_out_cuerpo + (x_in_brazo - x_out_cuerpo) / 2)), 4),
                            round(float((band[:, 1].min() + band[:, 1].max()) / 2), 4), round(float(z0), 4)],
                    "mm": (t.extents * 1000).round(1).tolist(), "estanca": bool(t.is_watertight)}
info["cuerpo"] = {"mm": (t_cuerpo.extents * 1000).round(1).tolist(), "estanca": bool(t_cuerpo.is_watertight)}
json.dump(info, open("piezas/piezas_v2.json", "w"), indent=1)
print(json.dumps(info, indent=1))
