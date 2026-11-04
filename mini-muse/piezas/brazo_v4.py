"""Brazo v4: pieza MACIZA (se imprime con relleno) con un tarugo que entra al cuerpo y recibe el horn del SG90.

Montaje: el horn simple del SG90 se atornilla al bolsillo del tarugo (2 tornillitos del kit). Se mete el tarugo
por el agujero del costado, el horn calza en el eje del servo y se aprieta el tornillo central por el agujerito
de acceso del brazo, que luego se tapa con un tapón impreso.
"""
import json
import numpy as np, trimesh
from trimesh.creation import cylinder, box

J = json.load(open("piezas/piezas_v3.json"))
PARED_EXT = 0.081          # costado del cuerpo (semiancho)
PARED = 0.0024
TARUGO_R = 0.010           # Ø20
AGUJERO_R = 0.0108         # Ø21.6 en la pared (0.8 mm de holgura)


def eje_x(L, x0, x1, y, z):
    c = cylinder(radius=L, height=abs(x1 - x0), sections=64)
    c.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
    c.apply_translation([(x0 + x1) / 2, y, z]); return c


info = {}
for nombre, s in (("brazo_der", 1), ("brazo_izq", -1)):
    b = trimesh.load(f"piezas/{nombre}_v3.ply")
    ex, ey, ez = J[nombre]["eje"]
    x_in = b.vertices[:, 0].min() if s > 0 else b.vertices[:, 0].max()
    x_seat = x_in + s * 0.0015                         # asiento plano (2 mm) del lado que mira al cuerpo
    b = b.slice_plane([x_seat, 0, 0], [s, 0, 0], cap=True)
    x_fin = s * (PARED_EXT - PARED - 0.001)            # punta del tarugo: 1 mm adentro de la pared
    tarugo = eje_x(TARUGO_R, x_seat + s * 0.002, x_fin, ey, ez)
    b = b.union(tarugo, engine="manifold")
    # bolsillo del horn simple SG90 (19 x 6 x 1.6 mm) + cubo del horn Ø7.5
    horn = box([0.0022, 0.0062, 0.0195]); horn.apply_translation([x_fin - s * 0.0011, ey, ez - 0.0055])
    cubo = eje_x(0.0038, x_fin, x_fin + s * 0.0025, ey, ez)
    acceso = eje_x(0.0035, x_fin, x_seat + s * 0.040, ey, ez)            # agujerito para el destornillador
    tornillos = [eje_x(0.0008, x_fin, x_fin + s * 0.008, ey, ez - d) for d in (0.0085, 0.0135)]
    for c in [horn, cubo, acceso] + tornillos:
        b = b.difference(c, engine="manifold")
    b.export(f"piezas/{nombre}_v4.stl")
    info[nombre] = {"estanca": bool(b.is_watertight), "volumen_cm3": round(b.volume * 1e6, 1),
                    "masa_g_15pc": round((b.area * 0.0012 + max(b.volume - b.area * 0.0012, 0) * 0.15) * 1240 * 1000, 0),
                    "tarugo_hasta_x_mm": round(x_fin * 1000, 1)}
info["agujero_cuerpo_diam_mm"] = AGUJERO_R * 2000
info["servo_cara_superior_x_mm"] = round((PARED_EXT - PARED - 0.001 - 0.0045) * 1000, 1)
json.dump(info, open("piezas/brazo_v4.json", "w"), indent=1)
print(json.dumps(info, indent=1))
