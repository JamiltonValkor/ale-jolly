"""Hoja: referencia (arriba) vs render del modelo (abajo) en las 4 vistas."""
import sys
from PIL import Image, ImageDraw, ImageFont
pref = sys.argv[1]; out = sys.argv[2]
V = ["frente", "tres_cuartos", "lado", "espalda"]
S = 420
hoja = Image.new("RGB", (S * 4, S * 2 + 40), "white"); d = ImageDraw.Draw(hoja)
f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 22)
for i, v in enumerate(V):
    hoja.paste(Image.open(f"modelo_ia/{v}.png").convert("RGB").resize((S, S)), (i * S, 40))
    hoja.paste(Image.open(f"{pref}_{v}.png").convert("RGB").resize((S, S)), (i * S, 40 + S))
    d.text((i * S + 10, 8), v.replace("_", " "), font=f, fill=(40, 40, 40))
hoja.save(out); print("ok")
