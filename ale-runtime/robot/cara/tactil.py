"""Táctil resistivo de la MPI3508 (ADS7846). SDL no conoce esta calibración: se lee el evdev directo y se entrega el
toque ya en coordenadas lógicas de 480×320, tal como se ve la pantalla montada a 180°.
Medido el 2026-11-01 con 3 blancos (el centro cayó a 1,2 % de donde debía): los ejes del panel van cruzados.
"""
import os, struct

RUTA = "/dev/input/by-path/platform-1f00050000.spi-cs-1-event"
W, H = 480, 320
Y_IZQ, Y_ANCHO = 127, 3863              # el eje Y crudo es lo horizontal de la pantalla
X_ARRIBA, X_ALTO = 105, 3731            # el eje X crudo es lo vertical
MIN_MUESTRAS = 3                         # menos que esto es un roce
EV_SYN, EV_KEY, EV_ABS, BTN_TOUCH = 0, 1, 3, 330
EVENTO = struct.Struct("llHHi")


def a_pantalla(cx: int, cy: int) -> tuple[float, float]:
    x = (cy - Y_IZQ) / Y_ANCHO * W
    y = (cx - X_ARRIBA) / X_ALTO * H
    return min(max(x, 0), W), min(max(y, 0), H)


class Tactil:
    def __init__(self, ruta: str = RUTA):
        self.f = os.open(ruta, os.O_RDONLY | os.O_NONBLOCK)
        self.x = self.y = None
        self.abajo = False
        self.xs, self.ys = [], []

    def _evento(self, tipo: int, codigo: int, valor: int):
        if tipo == EV_ABS and codigo == 0:
            self.x = valor
        elif tipo == EV_ABS and codigo == 1:
            self.y = valor
        elif tipo == EV_KEY and codigo == BTN_TOUCH:
            self.abajo = bool(valor)
            if not valor:
                xs, ys = sorted(self.xs), sorted(self.ys)
                self.xs, self.ys = [], []
                if len(xs) >= MIN_MUESTRAS:
                    return a_pantalla(xs[len(xs) // 2], ys[len(ys) // 2])
        elif tipo == EV_SYN and self.abajo and self.x is not None:
            self.xs.append(self.x); self.ys.append(self.y)
        return None

    def leer(self) -> list[tuple[float, float]]:
        """Toques terminados desde la última vuelta. No bloquea."""
        toques = []
        try:
            d = os.read(self.f, EVENTO.size * 64)
        except BlockingIOError:
            return toques
        for _, _, tipo, codigo, valor in EVENTO.iter_unpack(d):
            t = self._evento(tipo, codigo, valor)
            if t:
                toques.append(t)
        return toques
