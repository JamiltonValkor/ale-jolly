"""Re-exporta IMPRIMIR_YA en MILÍMETROS y con malla cerrada (Bambu lee los STL en mm).

Los STL estaban en metros: Bambu los veía diminutos y, al convertirlos, la precisión float32
dejaba bordes abiertos (1 non-manifold edge). Aquí: ×1000, se sueldan vértices, manifold3d
cierra la malla y se comprueba con trimesh antes de escribir.
"""
import glob, json, os, numpy as np, trimesh, manifold3d as m3

D = "imprimir/IMPRIMIR_YA"
res = {}
for f in sorted(glob.glob(f"{D}/0*.stl")):
    t = trimesh.load(f)
    if t.extents.max() < 1.0:                      # está en metros
        t.apply_scale(1000.0)
    t.merge_vertices(digits_vertex=4)
    me = m3.Mesh(vert_properties=np.asarray(t.vertices, np.float32), tri_verts=np.asarray(t.faces, np.uint32))
    me.merge()
    man = m3.Manifold(me)
    assert man.status() == m3.Error.NoError, (f, man.status())
    o = man.to_mesh()
    V, F = np.asarray(o.vert_properties)[:, :3].astype(np.float64), np.asarray(o.tri_verts)
    # astillas sueltas (4 triángulos de volumen 0): fuera
    t1 = trimesh.Trimesh(V, F, process=False)
    t1 = trimesh.util.concatenate([p for p in t1.split(only_watertight=False) if len(p.faces) > 100])
    V, F = t1.vertices.copy(), t1.faces
    # vértices distintos en la misma posición (pellizcos): al leer el STL se fusionan y salen
    # bordes non-manifold → se separan 0.02 mm hacia el centro de sus propios triángulos
    _, inv, cnt = np.unique(V.round(5), axis=0, return_inverse=True, return_counts=True)
    dup = np.nonzero(cnt[inv.ravel()] > 1)[0]
    if len(dup):
        cen = V[F].mean(axis=1)
        acc = np.zeros_like(V); nn = np.zeros(len(V))
        np.add.at(acc, F.ravel(), np.repeat(cen, 3, axis=0)); np.add.at(nn, F.ravel(), 1)
        d = acc[dup] / nn[dup, None] - V[dup]
        V[dup] += 0.02 * d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    t2 = trimesh.Trimesh(V, F, process=False)
    t2 = trimesh.Trimesh(*map(np.asarray, (t2.vertices.astype(np.float32), t2.faces)), process=True)  # como lo leerá Bambu
    t2.apply_translation([-t2.bounds[:, 0].mean(), -t2.bounds[:, 1].mean(), -t2.bounds[0, 2]])
    ok = bool(t2.is_watertight and t2.is_winding_consistent)
    n = os.path.basename(f)[:-4]
    res[n] = dict(mm=t2.extents.round(1).tolist(), triangulos=len(t2.faces), cerrada=ok,
                  piezas=len(t2.split(only_watertight=False)))
    print(n, res[n])
    assert ok, n
    t2.export(f)
json.dump(res, open(f"{D}/verificacion_mm.json", "w"), indent=1)
