"""Botón desplegable Dormir/Despertar (owner 2026-10-31): el primer toque lo abre, el segundo ejecuta.

Recogido es un círculo discreto en la esquina; abierto, una píldora que se recoge sola a los 4 s. Despierta se
ve siempre, salvo en las animaciones. Dormida, tocar en cualquier parte lo abre, para que un roce no la despierte.
La entrada de toque queda aislada en a_logico(): tecla y bus no pasan por aquí.
"""
import math

import pygame

from sueno import BANDA, INDIGO

W, H = 480, 320
AUTO_RECOGER = 4.0
LUNA = (250, 214, 120)
APAGADO = (118, 112, 150)                # recogido: discreto sobre la crema, sin transparencias
CIRCULO = (438, 286, 24)                 # cx, cy, radio
ZONA_CIRCULO = pygame.Rect(396, 244, 84, 76)   # área de dedo, mayor que lo visible
PILDORA = pygame.Rect(306, 262, 162, 48)
ZONA_PILDORA = pygame.Rect(295, 248, 185, 72)


def a_logico(x: float, y: float, tam: tuple[int, int], giro: int = 0) -> tuple[float, float]:
    """Píxel de pantalla → coordenadas de 480×320. Con la pantalla montada al revés (giro 180) se invierten."""
    lx, ly = x * W / tam[0], y * H / tam[1]
    return (W - lx, H - ly) if giro == 180 else (lx, ly)


class BotonSueno:
    def __init__(self):
        self.abierto = False
        self.t_abierto = 0.0
        self._piezas: dict[int, dict] = {}

    def recoger(self):
        self.abierto = False

    def actualizar(self, t: float, visible: bool):
        if self.abierto and (not visible or t - self.t_abierto >= AUTO_RECOGER):
            self.abierto = False

    def toque(self, x: float, y: float, t: float, dormida: bool) -> str | None:
        """Devuelve la acción si el toque la ejecuta. El llamador solo entrega toques con el botón visible."""
        if self.abierto:
            self.abierto = False
            if ZONA_PILDORA.collidepoint(x, y):
                return "despertar" if dormida else "dormir"
            return None
        if dormida or ZONA_CIRCULO.collidepoint(x, y):
            self.abierto, self.t_abierto = True, t
        return None

    def dibujar(self, L: pygame.Surface, ss: int, dormida: bool):
        piezas = self._piezas.setdefault(ss, {})
        clave = (self.abierto, dormida)
        if clave not in piezas:
            piezas[clave] = self._pildora(ss, dormida) if self.abierto else self._circulo(ss, dormida)
        pos = PILDORA.topleft if self.abierto else (CIRCULO[0] - CIRCULO[2], CIRCULO[1] - CIRCULO[2])
        L.blit(piezas[clave], (pos[0] * ss, pos[1] * ss))

    @staticmethod
    def _icono(sup, cx, cy, r, s, dormida, fondo):
        pygame.draw.circle(sup, LUNA, (cx, cy), r * s)
        if dormida:
            for k in range(8):
                a = k * math.pi / 4
                pygame.draw.line(sup, LUNA, (cx + (r + 3) * s * math.cos(a), cy + (r + 3) * s * math.sin(a)),
                                 (cx + (r + 8) * s * math.cos(a), cy + (r + 8) * s * math.sin(a)), 2 * s)
        else:
            pygame.draw.circle(sup, fondo, (cx + 5 * s, cy - 4 * s), (r - 1) * s)

    def _circulo(self, s, dormida):
        r = CIRCULO[2] * s
        sup = pygame.Surface((2 * r, 2 * r), pygame.SRCALPHA)
        pygame.draw.circle(sup, APAGADO, (r, r), r)
        self._icono(sup, r, r, 10, s, dormida, APAGADO)
        return sup

    def _pildora(self, s, dormida):
        w, h = PILDORA.w * s, PILDORA.h * s
        sup = pygame.Surface((w, h), pygame.SRCALPHA)
        pygame.draw.rect(sup, INDIGO, (0, 0, w, h), border_radius=h // 2)
        self._icono(sup, 28 * s, h // 2, 12, s, dormida, INDIGO)
        fuente = pygame.font.SysFont("helveticaneue,helvetica,dejavusans", 19 * s, bold=True)
        texto = fuente.render("Despertar" if dormida else "Dormir", True, BANDA)
        sup.blit(texto, (52 * s, (h - texto.get_height()) / 2))
        return sup
