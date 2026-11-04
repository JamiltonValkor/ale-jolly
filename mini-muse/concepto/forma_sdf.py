"""Mini-Muse concepto v0 — forma orgánica por SDF (unión suave) → mallas PLY.

Unidades: metros. z arriba, -y = frente. Alto total 0.32 m.
Piezas separadas porque se mueven: cuerpo, cabeza, brazo_izq, brazo_der.
"""
import numpy as np, trimesh
from skimage.measure import marching_cubes

RES = 0.0015


def ell(p, c, r):
    q = (p - c) / r
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / r, axis=-1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def capsule(p, a, b, ra, rb):
    pa, ba = p - a, b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0, 1)[..., None]
    return np.linalg.norm(pa - ba * h, axis=-1) - (ra + (rb - ra) * h[..., 0])


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def malla(f, lo, hi, nombre):
    xs = [np.arange(l, h, RES) for l, h in zip(lo, hi)]
    P = np.stack(np.meshgrid(*xs, indexing="ij"), -1)
    v, faces, _, _ = marching_cubes(f(P), 0.0, spacing=(RES,) * 3)
    m = trimesh.Trimesh(v + np.array(lo), faces[:, ::-1])
    m.merge_vertices()
    partes = m.split(only_watertight=False)
    m = max(partes, key=lambda x: len(x.faces))
    trimesh.smoothing.filter_taubin(m, iterations=10)
    m.fix_normals()
    m.export(f"concepto/{nombre}.ply")
    print(nombre, m.extents.round(3), "estanca", m.is_watertight)
    return m


# Proporciones medidas en la foto (H = 0.32 m): cabeza 0.38H, panza 0.54H, cara 0.30H x 0.19H
# centrada a 0.23H desde arriba, hombro a 0.45H desde arriba, brazo 0.30H, patitas 0.12H.
H = 0.32
HOMBRO = H - 0.45 * H  # 0.176
CARA_Z = H - 0.23 * H  # 0.246


def cuerpo(P):
    d = ell(P, np.array([0, 0, 0.100]), np.array([0.087, 0.075, 0.100]))
    d = smin(d, ell(P, np.array([0, 0.006, 0.170]), np.array([0.066, 0.050, 0.070])), 0.04)
    for sx in (-1, 1):  # patitas
        d = smin(d, ell(P, np.array([sx * 0.033, -0.006, 0.024]), np.array([0.024, 0.030, 0.026])), 0.010)
    return smax(d, -P[..., 2], 0.004)  # planta plana en z=0


def cabeza(P):
    d = ell(P, np.array([0, 0.002, 0.252]), np.array([0.061, 0.062, 0.068]))
    # faldón: los costados de la capucha bajan rectos hacia el cuerpo (sin "cuello")
    d = smin(d, ell(P, np.array([0, 0.008, 0.205]), np.array([0.060, 0.050, 0.030])), 0.03)
    # hueco ovalado de la cara (capucha)
    hueco = ell(P, np.array([0, -0.058, CARA_Z]), np.array([0.052, 0.026, 0.034]))
    return smax(d, -hueco, 0.010)


def brazo(sx, ang_deg):
    """sx=+1 lado derecho de la foto (+x). ang: 0 = colgando, 150 = arriba."""
    a = np.radians(ang_deg)
    piv = np.array([sx * 0.066, 0.0, HOMBRO])
    dirv = np.array([sx * np.sin(a), 0.0, -np.cos(a)])
    p0 = piv - dirv * 0.010
    p1 = piv + dirv * 0.080

    def f(P):
        return capsule(P, p0, p1, 0.020, 0.024)
    lo = np.minimum(p0, p1) - 0.035
    hi = np.maximum(p0, p1) + 0.035
    return f, lo, hi


if __name__ == "__main__":
    malla(cuerpo, (-0.10, -0.09, -0.002), (0.10, 0.09, 0.25), "cuerpo")
    malla(cabeza, (-0.075, -0.075, 0.16), (0.075, 0.075, 0.33), "cabeza")
    f, lo, hi = brazo(+1, 145); malla(f, lo, hi, "brazo_der")
    f, lo, hi = brazo(-1, 18); malla(f, lo, hi, "brazo_izq")
