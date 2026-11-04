"""Separa los bracitos de la malla fiel con un plano vertical (junta de disco: el eje del servo
es perpendicular al corte, así las dos caras planas siempre quedan pegadas al girar)."""
import trimesh, numpy as np, json
XC = 0.088            # plano de corte (m) a cada lado
m = trimesh.load('modelo_ia/muse_30cm.ply')
cuerpo = m.slice_plane([XC, 0, 0], [-1, 0, 0], cap=True).slice_plane([-XC, 0, 0], [1, 0, 0], cap=True)
der = m.slice_plane([XC, 0, 0], [1, 0, 0], cap=True)
izq = m.slice_plane([-XC, 0, 0], [-1, 0, 0], cap=True)
info = {}
for n, p in (("cuerpo", cuerpo), ("brazo_der", der), ("brazo_izq", izq)):
    p = max(p.split(only_watertight=False), key=lambda c: len(c.faces))
    p.export(f"piezas/{n}.ply")
    info[n] = {"estanca": bool(p.is_watertight), "mm": (p.extents * 1000).round(1).tolist()}
# eje del hombro: en la cara plana, a 26 mm bajo la punta superior del brazo, centrado en y
cara = der.vertices[np.abs(der.vertices[:, 0] - XC) < 1e-4]
ztop = cara[:, 2].max(); z0 = ztop - 0.026
banda = cara[np.abs(cara[:, 2] - z0) < 0.004]
y0 = (banda[:, 1].min() + banda[:, 1].max()) / 2
info["eje_hombro"] = {"x": XC, "y": round(float(y0), 4), "z": round(float(z0), 4)}
json.dump(info, open("piezas/piezas.json", "w"), indent=1)
print(json.dumps(info, indent=1))
