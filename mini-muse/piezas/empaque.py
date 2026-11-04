"""Estudio de empaque: componentes REALES dentro de la concha real (cuerpo_v3, pared 2.4 mm).

Revisa para cada componente: (a) que quepa dentro de la concha con la pared, (b) que no choque con otro.
Medidas en mm de fichas técnicas; las marcadas (V) hay que verificarlas con la pieza en mano.
"""
import json, itertools
import numpy as np, trimesh
from scipy import ndimage as nd

P = 0.001
PARED = 0.0024
mm = 1e-3

m = trimesh.load("piezas/cuerpo_v3.ply")
vox = trimesh.voxel.creation.voxelize(m, pitch=P).fill()
occ = np.pad(vox.matrix, 10); org = vox.transform[:3, 3] - 10 * P
sdf = (nd.distance_transform_edt(~occ) - nd.distance_transform_edt(occ)) * P
sdf = nd.gaussian_filter(sdf, 1.0)


def sdf_en(p):
    i = np.clip(np.round((p - org) / P).astype(int), 0, np.array(sdf.shape) - 1)
    return sdf[i[:, 0], i[:, 1], i[:, 2]]


J = json.load(open("piezas/piezas_v3.json"))
EJE = J["brazo_der"]["eje"]
# (nombre, centro m, tamaño m (x,y,z), nota)
C = [
    ("Raspberry Pi 5 + disipador activo", (0, 0.004, 0.103), (85, 56, 25), "acostada en la panza; aire entra por abajo"),
    ("Parlante 40 mm 3 W", (0, -0.006, 0.073), (40, 40, 20), "mirando hacia abajo, sale entre las patitas"),
    ("Pantalla 3.5\" DSI 640x480 (V)", (0, -0.045, 0.228), (85, 7, 56), "pegada detrás de la cara (placa traslúcida)"),
    ("Cámara Pi v3 Wide", (0, -0.035, 0.266), (25, 12, 24), "detrás de la pantalla; lente asoma en la frente de la cara"),
    ("Micrófonos XVF3800 (V)", (0, 0.010, 0.262), (86, 35, 10), "acostada arriba en la cabeza; agujeritos arriba"),
    ("SG90 brazo der", (0.0731 - 0.01125, EJE[1], EJE[2] - 0.0058), (22.5, 12.2, 32.3), "eje sale por el costado"),
    ("SG90 brazo izq", (-(0.0731 - 0.01125), EJE[1], EJE[2] - 0.0058), (22.5, 12.2, 32.3), ""),
    ("Lastre pie der (acero)", (0.033, -0.006, 0.020), (26, 34, 14), "~95 g de perdigones de acero con resina"),
    ("Lastre pie izq (acero)", (-0.033, -0.006, 0.020), (26, 34, 14), ""),
    ("Bornera 5 V + interruptor", (0, 0.055, 0.075), (30, 15, 15), "entrada de la fuente atrás, abajo"),
]


def muestras(c, s, n=7):
    g = [np.linspace(-0.5, 0.5, n)] * 3
    q = np.stack(np.meshgrid(*g, indexing="ij"), -1).reshape(-1, 3)
    return np.array(c) + q * np.array(s) * mm


filas, ok = [], True
for nombre, c, s, nota in C:
    d = sdf_en(muestras(c, s))
    margen = -(d.max()) - PARED          # >0 = cabe con la pared
    filas.append((nombre, s, round(margen * 1000, 1), nota))
    if margen < 0 and "Cámara" not in nombre:
        ok = False

choques = []
for (n1, c1, s1, _), (n2, c2, s2, _) in itertools.combinations(C, 2):
    a0, a1 = np.array(c1) - np.array(s1) * mm / 2, np.array(c1) + np.array(s1) * mm / 2
    b0, b1 = np.array(c2) - np.array(s2) * mm / 2, np.array(c2) + np.array(s2) * mm / 2
    sol = np.minimum(a1, b1) - np.maximum(a0, b0)
    if (sol > 0).all():
        choques.append((n1, n2, (sol * 1000).round(1).tolist()))

print(f"{'componente':38s} {'medida mm':16s} {'margen a la pared':>18s}")
for n, s, mg, nota in filas:
    print(f"{n:38s} {str(s):16s} {mg:14.1f} mm   {nota}")
print("choques entre componentes:", choques if choques else "ninguno")
json.dump({"componentes": [dict(nombre=n, centro=list(c), mm=list(s), nota=t) for n, c, s, t in C],
           "margenes": {n: mg for n, _, mg, _ in filas}, "choques": choques},
          open("piezas/empaque.json", "w"), indent=1, ensure_ascii=False)
