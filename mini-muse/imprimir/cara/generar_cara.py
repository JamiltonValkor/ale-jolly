"""Cara de Mini-Muse para la pantalla MPI3508 (480×320), con proporciones medidas en el dibujo de referencia.

Medidas en el dibujo (fracción del ancho de la cara): ojos ±0.254, diámetro 0.105; sonrisa ancho 0.158 a +0.15 del alto;
rubor ±0.286 a la altura de la boca. La ventana visible es 73.4×49 mm de una cara de 126 mm → rasgos escalados K.
"""
import sys
from PIL import Image, ImageDraw, ImageFilter
K = float(sys.argv[1]) if len(sys.argv) > 1 else 0.82
PXMM = 480 / 73.4; FW, FH = 126.0, 96.0; SS = 4
CREMA = (238, 222, 196)


def mm(x, y): return ((240 + x * PXMM) * SS, (160 + y * PXMM) * SS)


def cara(ojos_abiertos=1.0, sonrisa=1.0, rubor=1.0, salida="imprimir/cara/cara_neutra_480x320.png"):
    W, H = 480 * SS, 320 * SS
    im = Image.new("RGB", (W, H), CREMA)
    bl = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(bl)
    for sx in (-1, 1):
        cx, cy = mm(sx * 0.286 * FW * K, 0.14 * FH * K)
        rx, ry = 0.10 * FW * K * PXMM * SS, 0.08 * FW * K * PXMM * SS
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(242, 150, 155, int(150 * rubor)))
    bl = bl.filter(ImageFilter.GaussianBlur(11 * SS)); im.paste(bl, (0, 0), bl)
    d = ImageDraw.Draw(im)
    for sx in (-1, 1):
        cx, cy = mm(sx * 0.254 * FW * K, -0.01 * FH * K); r = 0.0525 * FW * K * PXMM * SS
        ry = r * 1.04 * max(ojos_abiertos, 0.08)
        d.ellipse([cx - r, cy - ry, cx + r, cy + ry], fill=(18, 14, 16))
        if ojos_abiertos > 0.5:
            d.ellipse([cx - r * 0.55, cy - r * 0.72, cx - r * 0.05, cy - r * 0.22], fill=(255, 255, 255))
    mw = 0.158 * FW * K * PXMM * SS; cx, cy = mm(0, 0.14 * FH * K)
    d.arc([cx - mw / 2, cy - mw * 0.45 * sonrisa, cx + mw / 2, cy + mw * 0.25 * sonrisa], start=20, end=160,
          fill=(30, 20, 22), width=int(2.2 * SS * PXMM * 0.6))
    im.resize((480, 320), Image.LANCZOS).save(salida)


if __name__ == "__main__":
    cara(); print("ok")
