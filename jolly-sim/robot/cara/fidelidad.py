"""Compara la cara neutra del motor con la referencia (mini-muse/imprimir/cara/cara_neutra_480x320.png).

Criterios CV-005: IoU ≥ 0,9 de la máscara oscura (ojos+boca); error medio en la región del rubor < 5 %;
centroides de ojos y boca a ≤ 2 px. Guarda una comparación lado a lado en capturas/fidelidad.png.
.venv/bin/python fidelidad.py
"""
import os, sys
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import numpy as np
import pygame
from PIL import Image

from render import Render, BOCA_Y, RUBOR_X, RUBOR_RX, RUBOR_RY
from parametros import NEUTRA

AQUI = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(AQUI, "..", "..", "imprimir", "cara", "cara_neutra_480x320.png")


def a_numpy(sup: pygame.Surface) -> np.ndarray:
    return np.transpose(pygame.surfarray.array3d(sup), (1, 0, 2)).astype(np.float32)


def centroides(oscuro: np.ndarray) -> dict:
    ys, xs = np.nonzero(oscuro)
    out = {}
    for nombre, sel in (("ojo_izq", (xs < 200) & (ys < 210)), ("ojo_der", (xs > 280) & (ys < 210)), ("boca", ys > 210)):
        out[nombre] = (float(xs[sel].mean()), float(ys[sel].mean())) if sel.any() else (float("nan"),) * 2
    return out


def medir(img: np.ndarray, ref: np.ndarray) -> dict:
    lum = lambda a: a @ np.array([0.299, 0.587, 0.114])
    m1, m2 = lum(img) < 90, lum(ref) < 90
    iou = (m1 & m2).sum() / max(1, (m1 | m2).sum())
    yy, xx = np.mgrid[0:320, 0:480]
    region = np.zeros((320, 480), bool)
    for lado in (-1, 1):
        region |= ((xx - (240 + lado * RUBOR_X)) / (RUBOR_RX * 1.3)) ** 2 + ((yy - BOCA_Y) / (RUBOR_RY * 1.3)) ** 2 <= 1
    region &= ~(m1 | m2)
    err_rubor = float(np.abs(img[region] - ref[region]).mean() / 255)
    c1, c2 = centroides(m1), centroides(m2)
    dist = {k: float(np.hypot(c1[k][0] - c2[k][0], c1[k][1] - c2[k][1])) for k in c1}
    return {"iou": float(iou), "err_rubor": err_rubor, "dist_px": dist}


def main():
    pygame.init()
    img = a_numpy(Render().dibujar(dict(NEUTRA)))
    ref = np.asarray(Image.open(REF).convert("RGB"), dtype=np.float32)
    r = medir(img, ref)
    ok = r["iou"] >= 0.9 and r["err_rubor"] < 0.05 and max(r["dist_px"].values()) <= 2
    os.makedirs(os.path.join(AQUI, "capturas"), exist_ok=True)
    lado = np.concatenate([img, np.full((320, 8, 3), 255, np.float32), ref], axis=1).astype(np.uint8)
    Image.fromarray(lado).save(os.path.join(AQUI, "capturas", "fidelidad.png"))
    print(f"IoU oscuro {r['iou']:.3f} (≥0.90) · error rubor {r['err_rubor']*100:.1f}% (<5%) · "
          + " · ".join(f"{k} {v:.1f}px" for k, v in r["dist_px"].items()) + f" → {'OK' if ok else 'NO'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
