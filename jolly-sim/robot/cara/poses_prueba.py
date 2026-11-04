"""Hoja de poses límite (CV-005): abierto, entrecerrado, feliz ^ ^, cerrado, boca abierta, giro, preocupada."""
import os; os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import pygame
from PIL import Image, ImageDraw
from parametros import expandir
from render import Render
POSES = [
    ("neutra", {}),
    ("entrecerrado", {"ojos.sup": 0.45, "ojos.sup_curva": -0.2}),
    ("feliz ^ ^", {"ojos.inf": 0.5, "ojos.inf_curva": 1.1, "boca.sonrisa": 1.3, "rubor": 1.4}),
    ("cerrado", {"ojos.abierto": 0.0}),
    ("hablando", {"boca.apertura": 0.7, "boca.sonrisa": 0.8}),
    ("giro izq", {"giro": -1, "mirada_x": -0.6}),
    ("preocupada (con plan)", {"ojos.sup": 0.18, "ojos.sup_ang": -16, "boca.sonrisa": 0.25, "boca.ancho": 0.8, "rubor": 0.7}),
    ("mmm pensando", {"mirada_x": 0.7, "mirada_y": -0.8, "boca.lado": 0.6, "boca.sonrisa": 0.2, "boca.ancho": 0.6, "boca.tilt": -8}),
    ("curiosa", {"ladeo": 8, "ojos.escala": 1.08, "boca.sonrisa": 0.7, "boca.apertura": 0.15}),
]
pygame.init(); R = Render()
hoja = Image.new("RGB", (3 * 480 + 4 * 10, 3 * 350 + 10), (255, 255, 255)); d = ImageDraw.Draw(hoja)
for i, (n, e) in enumerate(POSES):
    s = R.dibujar(expandir(e)); img = Image.frombytes("RGB", (480, 320), pygame.image.tobytes(s, "RGB"))
    x, y = 10 + (i % 3) * 490, 10 + (i // 3) * 350
    hoja.paste(img, (x, y)); d.text((x + 6, y + 322), n, fill=(0, 0, 0))
os.makedirs("capturas", exist_ok=True); hoja.save("capturas/poses.png"); print("ok")
