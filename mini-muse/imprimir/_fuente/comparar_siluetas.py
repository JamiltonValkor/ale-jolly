"""Compara siluetas (IoU) de un modelo contra las fotos de referencia y dibuja superposiciones.

python imprimir/comparar_siluetas.py prefijo_render etiqueta
Rojo = solo en la foto (le falta al modelo) · Azul = solo en el modelo (le sobra) · Gris = coinciden.
"""
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage as nd

PREF, ETQ = sys.argv[1], sys.argv[2]
S = 600


def mascara_foto(f):
    a = np.asarray(Image.open(f).convert("RGB")).astype(int)
    m = (a.min(-1) < 235) | (np.ptp(a, -1) > 18)
    m = nd.binary_opening(m, iterations=2)
    lab, n = nd.label(m); m = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
    return nd.binary_fill_holes(m)


def mascara_render(f):
    return nd.binary_fill_holes(np.asarray(Image.open(f).convert("RGBA"))[..., 3] > 128)


def normalizar(m):
    """recorta al bbox, escala a la misma ALTURA y centra horizontalmente en un lienzo S×S"""
    ys, xs = np.nonzero(m); m = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = m.shape; k = (S * 0.9) / h
    im = Image.fromarray((m * 255).astype(np.uint8)).resize((max(1, int(w * k)), int(h * k)), Image.NEAREST)
    lienzo = np.zeros((S, S), bool); a = np.asarray(im) > 127
    y0 = int(S * 0.05); x0 = (S - a.shape[1]) // 2
    lienzo[y0:y0 + a.shape[0], max(x0, 0):max(x0, 0) + min(a.shape[1], S)] = a[:, :S]
    return lienzo


res, paneles = {}, []
for v in ("frente", "lado", "espalda"):
    ref = normalizar(mascara_foto(f"modelo_ia/{v}.png"))
    mod = normalizar(mascara_render(f"{PREF}_{v}.png"))
    iou = (ref & mod).sum() / (ref | mod).sum()
    res[v] = round(float(iou), 3)
    img = np.full((S, S, 3), 255, np.uint8)
    img[ref & mod] = (190, 190, 190); img[ref & ~mod] = (220, 40, 40); img[~ref & mod] = (40, 90, 220)
    paneles.append(img)
Image.fromarray(np.hstack(paneles)).save(f"{PREF}_comparacion.png")
print(ETQ, json.dumps(res))
