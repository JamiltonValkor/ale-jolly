"""La cara de siempre (`robot/cara/main.py --bus`) con una banda visible «REPLAY · traza real del …».

  python cara_replay.py --etiqueta "REPLAY · traza real del 2026-11-02" [opciones de main.py]

No cambia código de la cara: envuelve `Controlador.pantalla_encima`, que main.py llama en cada cuadro después de
dibujar, y pinta la banda encima. También marca el título de la ventana.
"""
import os, sys
from pathlib import Path

CARA = Path(__file__).resolve().parent.parent / "robot" / "cara"
sys.path.insert(0, str(CARA))
os.chdir(CARA)

import pygame                                            # noqa: E402

import controlador                                       # noqa: E402

FONDO, TEXTO = (196, 30, 58), (255, 255, 255)


def banda(etiqueta: str):
    cache = {}

    def dibujar(sup: pygame.Surface):
        w, h = sup.get_size()
        if cache.get("w") != w:
            alto = max(22, h // 11)
            fuente = pygame.font.SysFont("Helvetica", int(alto * 0.62), bold=True)
            cache.update(w=w, alto=alto, texto=fuente.render(etiqueta, True, TEXTO))
        alto, texto = cache["alto"], cache["texto"]
        pygame.draw.rect(sup, FONDO, (0, 0, w, alto))
        sup.blit(texto, ((w - texto.get_width()) // 2, (alto - texto.get_height()) // 2))
    return dibujar


def main():
    args = sys.argv[1:]
    etiqueta = "REPLAY"
    if "--etiqueta" in args:
        i = args.index("--etiqueta")
        etiqueta = args[i + 1]
        del args[i:i + 2]
    pintar = banda(etiqueta)
    original = controlador.Controlador.pantalla_encima

    def pantalla_encima(self, sup, t):
        original(self, sup, t)
        pintar(sup)
    controlador.Controlador.pantalla_encima = pantalla_encima
    titulo = pygame.display.set_caption
    pygame.display.set_caption = lambda texto, *a: titulo(f"{texto} · {etiqueta}", *a)
    sys.argv = ["main.py", "--bus", *args]
    import main as cara
    return cara.main()


if __name__ == "__main__":
    sys.exit(main())
