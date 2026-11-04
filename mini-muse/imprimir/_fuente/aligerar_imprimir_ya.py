"""Versión liviana de IMPRIMIR_YA: mismas piezas y medidas, muchos menos triángulos.

Bambu sufre con 1.5 M de triángulos y su "simplificar" rompe la malla (152 bordes non-manifold).
Aquí se simplifica con manifold3d, que conserva la malla cerrada, con un error máximo de TOL mm.
Uso (desde mini-muse/): python imprimir/_fuente/aligerar_imprimir_ya.py <carpeta_entrada> <carpeta_salida>
"""
import glob, json, os, sys, numpy as np, trimesh, manifold3d as m3

ENT, SAL = sys.argv[1], sys.argv[2]
TOL = float(sys.argv[3]) if len(sys.argv) > 3 else 0.08


def pellizcos(V, F):
    """Separa vértices distintos que caen en el mismo punto (el lector de STL los fundiría)."""
    for _ in range(3):
        _, inv, cnt = np.unique(V.astype(np.float32), axis=0, return_inverse=True, return_counts=True)
        dup = np.nonzero(cnt[inv.ravel()] > 1)[0]
        if not len(dup):
            break
        cen = V[F].mean(axis=1); acc = np.zeros_like(V); nn = np.zeros(len(V))
        np.add.at(acc, F.ravel(), np.repeat(cen, 3, axis=0)); np.add.at(nn, F.ravel(), 1)
        d = acc[dup] / nn[dup, None] - V[dup]
        V[dup] += 0.02 * d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    return V


os.makedirs(SAL, exist_ok=True); res = {}
for f in sorted(glob.glob(f"{ENT}/0*.stl")):
    t = trimesh.load(f)
    me = m3.Mesh(vert_properties=np.asarray(t.vertices, np.float32), tri_verts=np.asarray(t.faces, np.uint32))
    me.merge(); man = m3.Manifold(me)
    assert man.status() == m3.Error.NoError, f
    ligero = man.simplify(TOL)
    o = ligero.to_mesh()
    V, F = np.asarray(o.vert_properties)[:, :3].astype(np.float64), np.asarray(o.tri_verts)
    t1 = trimesh.Trimesh(V, F, process=False)
    t1 = trimesh.util.concatenate([p for p in t1.split(only_watertight=False) if len(p.faces) > 100])
    V = pellizcos(t1.vertices.copy(), t1.faces)
    dst = f"{SAL}/{os.path.basename(f)}"
    trimesh.Trimesh(V, t1.faces, process=False).export(dst)
    r = trimesh.load(dst)                                       # se comprueba el archivo escrito, como lo lee Bambu
    e = np.sort(r.edges, axis=1); _, c = np.unique(e, axis=0, return_counts=True)
    res[os.path.basename(f)] = dict(mm=r.extents.round(1).tolist(), triangulos=len(r.faces), malos=int((c != 2).sum()),
                                    cerrada=bool(r.is_watertight), cm3=round(r.volume / 1000, 1))
    print(os.path.basename(f), res[os.path.basename(f)], flush=True)
