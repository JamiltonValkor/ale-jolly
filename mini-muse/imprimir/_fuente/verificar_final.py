"""Verificación del diseño FINAL: choques con componentes reales, piezas entre sí y barrido de brazos 0–150°."""
import json, numpy as np, trimesh, manifold3d as m3
from trimesh.creation import box

D = "imprimir/_fuente/stl_final"
R = json.load(open("imprimir/_fuente/reporte_final.json"))["_param"]
S, X_TOP = R["S"], R["X_TOP"]; _, EY, EZ = R["EJE"]


def M(t):
    me = m3.Mesh(vert_properties=np.asarray(t.vertices, np.float32), tri_verts=np.asarray(t.faces, np.uint32))
    me.merge(); return m3.Manifold(me)


def caja(c, mm):
    b = box(np.array(mm) / 1000); b.apply_translation(c); return M(b)


def vol(a, b): return round((a ^ b).volume() * 1e9, 1)


PZ = {n: M(trimesh.load(f"{D}/{n}.stl")) for n in ("P1_cabeza", "P2_cuerpo", "P3_cara", "P4_brazo_derecho", "P5_brazo_izquierdo")}
C = R["CARA"]; T = R["PANT"]["grosor"]
comp = {}
for s, n in ((1, "der"), (-1, "izq")):
    comp[f"SG90 {n}"] = caja((s * (X_TOP - 0.01125), EY, EZ - 0.0058), (22.5, 12.2, 22.8))
    comp[f"SG90 {n} orejas"] = caja((s * (X_TOP - 0.0068 + 0.00125), EY, EZ - 0.0058), (2.5, 12.2, 32.3))
yv = R["Y_FRENTE"] + 0.0012; cz = C["cz"]
comp["Pantalla: placa 85.5×56"] = caja((0, yv + T / 2, cz), (85.5, T * 1000, 56.0))
comp["Pantalla: conectores USB/HDMI/jack (abajo)"] = (caja((-0.032, yv + T + 0.003, cz - 0.028 - 0.0023), (8, 7, 4.6)) +
    caja((-0.0105, yv + T + 0.003, cz - 0.028 - 0.0023), (15, 7, 4.6)) + caja((0.0113, yv + T + 0.003, cz - 0.028 - 0.0023), (6.5, 7, 4.6)))
comp["Pantalla: conector 26 pines (atrás arriba)"] = caja((-0.010, yv + T + 0.0043, cz + 0.0245), (51, 8.5, 5))
comp["Raspberry Pi 5 + cooler"] = caja(R["PI_C"], (85, 56, 25))
from trimesh.creation import cylinder
comp["Parlante Gikfun 40 mm (redondo)"] = M(cylinder(radius=0.020, segment=[[0, -0.006, R["Z_PARL"] + 0.0003], [0, -0.006, R["Z_PARL"] + 0.0223]], sections=64))
comp["Amplificador (≤44×34×12)"] = caja((0, 0.038, R["Z_AMP"] + 0.0065), (44, 34, 12))
comp["Cámara USB 38×38"] = caja((0, R["y_pecho"] + 0.0024 + R["CAM_prof"] + 0.0065, R["CAM_z"]), (38, 12, 38))
for s, n in ((1, "der"), (-1, "izq")):
    comp[f"Lastre pie {n}"] = caja((s * 0.033 * S, -0.006 * S, 0.020 * S), (26, 34, 14))
pi = trimesh.load("cad_real/stl/pi5.stl"); pi.apply_scale(0.001); b = pi.bounds
pi.apply_translation([R["PI_C"][0] - (b[0, 0] + b[1, 0]) / 2, R["PI_C"][1] - (b[0, 1] + b[1, 1]) / 2, R["PI_C"][2] - 0.0125 - b[0, 2]])
comp["Pi 5 (modelo oficial)"] = M(pi.convex_hull)

res = {"componentes": {}, "piezas": {}, "barrido": {}}
print(f"{'componente':28s} " + " ".join(f"{p[:9]:>10s}" for p in PZ))
for n, c in comp.items():
    fila = {p: vol(c, m) for p, m in PZ.items()}; res["componentes"][n] = fila
    print(f"{n:28s} " + " ".join(f"{v:10.1f}" for v in fila.values()))
ns = list(PZ)
for i in range(len(ns)):
    for j in range(i + 1, len(ns)):
        res["piezas"][f"{ns[i]} x {ns[j]}"] = vol(PZ[ns[i]], PZ[ns[j]])
print("piezas entre sí:", {k: v for k, v in res["piezas"].items() if v > 0} or "0 mm³ en todas")
fijo = PZ["P1_cabeza"] + PZ["P2_cuerpo"] + PZ["P3_cara"]
for n in ("P4_brazo_derecho", "P5_brazo_izquierdo"):
    peor = 0
    for ang in range(0, 151, 10):
        Tm = trimesh.transformations.rotation_matrix(np.radians(-ang), [1, 0, 0], [0, EY, EZ])
        v = vol(PZ[n].transform(np.asarray(Tm[:3, :4], np.float64)), fijo); peor = max(peor, v)
        res["barrido"][f"{n} {ang}"] = v
    print(f"{n}: choque máximo al girar 0–150° = {peor} mm³")
json.dump(res, open("imprimir/_fuente/verificacion_final.json", "w"), indent=1, ensure_ascii=False)
