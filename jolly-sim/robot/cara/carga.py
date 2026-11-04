"""Pantalla de carga del arranque (aprobada por el owner 2026-11-01): Jolly dormida con gorrito, sin zzz, con
«Jolly está despertando…» y tres puntos hasta que la voz dé señales. Corre sobre el modo dormir (sueno.py): así sale
sin salto a despierta, dormida o vinculación, y cuesta lo mismo que dormida (8 fps).
"""
import pygame

from sueno import DORMIDA, INDIGO, LAVANDA

TEXTO = "Jolly está despertando…"
SIN_INTERNET = "No tengo internet ahorita"
ESPERA_BUS = 45.0                      # sin mensajes de la voz: sale sola a reposo
ESPERA_SIN_BUS = 2.0
POSE = {**DORMIDA, "subir": 14}        # sube la cara para que el texto quede libre
ANCHO_MAX, TEXTO_Y, PUNTOS_Y, PASO_PUNTOS = 440, 258, 304, 0.45


class Carga:
    def __init__(self):
        self.activa = False
        self.limite = 0.0
        self._texto: dict[tuple, pygame.Surface] = {}

    def iniciar(self, t: float, espera: float):
        self.activa, self.limite = True, t + espera

    def vencio(self, t: float) -> bool:
        return self.activa and t >= self.limite

    def texto(self, ss: int, mensaje: str = TEXTO) -> pygame.Surface:
        if (ss, mensaje) not in self._texto:
            fuente = pygame.font.SysFont("helveticaneue,helvetica,dejavusans", 29 * ss, bold=True)
            sup = fuente.render(mensaje, True, INDIGO)
            if sup.get_width() > ANCHO_MAX * ss:           # en la Pi la fuente es más ancha
                alto = sup.get_height() * ANCHO_MAX * ss // sup.get_width()
                sup = pygame.transform.smoothscale(sup, (ANCHO_MAX * ss, alto))
            self._texto[ss, mensaje] = sup
        return self._texto[ss, mensaje]

    def dibujar(self, L: pygame.Surface, ss: int, t: float, sin_internet: bool = False):
        texto = self.texto(ss, SIN_INTERNET if sin_internet else TEXTO)
        L.blit(texto, (240 * ss - texto.get_width() / 2, TEXTO_Y * ss))
        if sin_internet:
            return
        llenos = int(t / PASO_PUNTOS) % 4
        for i in range(3):
            pygame.draw.circle(L, INDIGO if i < llenos else LAVANDA, ((216 + 24 * i) * ss, PUNTOS_Y * ss), 7 * ss)
