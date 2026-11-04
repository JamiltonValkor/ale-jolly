"""Pone rótulos con línea guía sobre concepto_interior.png usando etiquetas.json."""
import json
from PIL import Image, ImageDraw, ImageFont

im = Image.open("concepto/concepto_interior.png").convert("RGB")
W, H = im.size
lienzo = Image.new("RGB", (W + 520, H), (250, 247, 243))
lienzo.paste(im, (260, 0))
d = ImageDraw.Draw(lienzo)
try:
    f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 24)
    ft = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 30)
except OSError:
    f = ft = ImageFont.load_default()

et = json.load(open("concepto/etiquetas.json"))
izq = sorted([(k, v) for k, v in et.items() if v[0] < 0.5], key=lambda kv: kv[1][1])
der = sorted([(k, v) for k, v in et.items() if v[0] >= 0.5], key=lambda kv: kv[1][1])


def poner(lista, x_txt, alinear_der):
    n = len(lista)
    for i, (k, (u, v)) in enumerate(lista):
        px, py = 260 + u * W, v * H
        ty = 140 + i * (H - 280) / max(n - 1, 1)
        tw = d.textlength(k, font=f)
        tx = x_txt - tw if alinear_der else x_txt
        ancla = x_txt + (8 if alinear_der else -8)
        d.line([(ancla, ty + 14), (px, py)], fill=(60, 60, 70), width=2)
        d.ellipse([px - 5, py - 5, px + 5, py + 5], fill=(220, 60, 90))
        d.text((tx, ty), k, font=f, fill=(30, 30, 40))


poner(izq, 245, True)
poner(der, 260 + W + 20, False)
d.text((20, 20), "Mini-Muse con SG90 — vista en corte (concepto v0)", font=ft, fill=(30, 30, 40))
lienzo.save("concepto/concepto_interior_rotulado.png")
print("ok")
