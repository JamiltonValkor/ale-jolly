"""v3: cuerpo de la malla fiel SIN brazos (costados redondos) + bracitos modelados como manoplas
redondas e independientes. Todo con campos de distancia (SDF) para que las uniones queden suaves.

- El cuerpo es la malla de Hunyuan recortada por una "envoltura" elíptica suave solo a la altura de
  los brazos (z 6–19 cm); la cabeza, la cara y las patitas quedan intactas.
- Cada brazo es una manopla (brazo + mano) que llena la silueta original del brazo en la foto de frente.
- El brazo gira hacia adelante alrededor del eje x (eje del SG90 sale del costado del cuerpo):
  como los puntos del brazo conservan su x al girar, basta con que todo el brazo esté a ≥ HOLGURA
  del costado del cuerpo para que nunca choque.
"""
import json
import numpy as np, trimesh
from scipy import ndimage as nd
from skimage.measure import marching_cubes

P = 0.001
HOLGURA = 0.004

m = trimesh.load("modelo_ia/muse_30cm.ply")
vox = trimesh.voxel.creation.voxelize(m, pitch=P).fill()
occ = np.pad(vox.matrix, 40)
org = vox.transform[:3, 3] - 40 * P
X = org[0] + np.arange(occ.shape[0]) * P
Y = org[1] + np.arange(occ.shape[1]) * P
Z = org[2] + np.arange(occ.shape[2]) * P
GX, GY, GZ = np.meshgrid(X.astype(np.float32), Y.astype(np.float32), Z.astype(np.float32), indexing="ij")
sdf = ((nd.distance_transform_edt(~occ) - nd.distance_transform_edt(occ)) * P).astype(np.float32)
sdf = nd.gaussian_filter(sdf, 2.0)          # quita el escalonado de los vóxeles


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1); return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def ell(c, r):
    q0 = np.sqrt(((GX - c[0]) / r[0]) ** 2 + ((GY - c[1]) / r[1]) ** 2 + ((GZ - c[2]) / r[2]) ** 2)
    return (q0 - 1) * min(r)


def a_malla(d, nombre):
    v, f, _, _ = marching_cubes(d, 0.0, spacing=(P, P, P))
    t = trimesh.Trimesh(v + org, f[:, ::-1]); t.merge_vertices(); t.fix_normals()
    t = max(t.split(only_watertight=False), key=lambda c: len(c.faces))
    trimesh.smoothing.filter_taubin(t, iterations=10)
    t.export(f"piezas/{nombre}.ply")
    return t


# ---- cuerpo: semiancho permitido a(z) a la altura de los brazos ----
zz = [0.030, 0.050, 0.068, 0.100, 0.130, 0.160, 0.178, 0.196, 0.220]
aa = [0.200, 0.095, 0.0765, 0.0765, 0.0765, 0.0765, 0.0780, 0.090, 0.200]
a_z = np.interp(GZ, zz, aa)
B = 0.115                                             # semifondo amplio: solo recorta en x
d_env = (np.sqrt((GX / a_z) ** 2 + (GY / B) ** 2) - 1) * a_z
# rellenar las abolladuras que dejó la unión brazo-cuerpo: elipse interior por altura
ys_occ = np.where(occ.any(axis=0), 1, 0)            # (y, z)
yc_z = np.zeros(len(Z), np.float32); b_z = np.full(len(Z), 1e-3, np.float32)
for k in range(len(Z)):
    col = np.nonzero(ys_occ[:, k])[0]
    if len(col):
        yc_z[k] = (Y[col[0]] + Y[col[-1]]) / 2; b_z[k] = max((Y[col[-1]] - Y[col[0]]) / 2 - 0.012, 1e-3)
peso = np.interp(Z, [0.060, 0.075, 0.180, 0.200], [0, 1, 1, 0]).astype(np.float32)
YC = yc_z[None, None, :]; BZ = b_z[None, None, :]; AF = a_z - 0.005
d_fill = (np.sqrt((GX / AF) ** 2 + ((GY - YC) / BZ) ** 2) - 1) * np.minimum(AF, BZ)
d_fill = np.where(peso[None, None, :] > 0, d_fill + (1 - peso[None, None, :]) * 0.05, 1.0).astype(np.float32)
cuerpo = smax(smin(sdf, d_fill, 0.010), d_env, 0.018)
t_c = a_malla(cuerpo, "cuerpo_v5")

# ---- brazos: manopla = brazo + mano, llenando la silueta original ----
info = {"cuerpo": {"mm": (t_c.extents * 1000).round(1).tolist(), "estanca": bool(t_c.is_watertight)}}
x_cuerpo = 0.081
for nombre, s in ():
    brazo = smin(ell((s * 0.107, -0.002, 0.135), (0.019, 0.036, 0.042)),
                 ell((s * 0.109, -0.008, 0.093), (0.021, 0.041, 0.028)), 0.022)
    t_b = a_malla(brazo, nombre + "_v3")
    xin = (t_b.vertices[:, 0].min() if s > 0 else -t_b.vertices[:, 0].max())
    info[nombre] = {"mm": (t_b.extents * 1000).round(1).tolist(), "estanca": bool(t_b.is_watertight),
                    "holgura_mm": round((xin - x_cuerpo) * 1000, 1),
                    "eje": [round(s * (x_cuerpo + xin) / 2, 4), -0.002, 0.155]}
json.dump(info, open("piezas/piezas_v5.json", "w"), indent=1)
print(json.dumps(info, indent=1))
