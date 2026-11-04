"""Modo dormir de la cara: gorrito, ojos cerrados, zzz y las dos animaciones (aprobado por el owner 2026-10-31).

Cuatro estados: despierta → durmiendose (3,8 s) → dormida → despertando (3,0 s) → despierta. La voz decide cuándo
dormir: la cara pide con cara/toque, obedece a cuerpo/sueno {orden: dormir|despertar} y avisa con cara/sueno
{estado, dur} en el bus de la cara, para que brazos y voz acompañen cada animación.
Una orden que llega en plena animación espera a que termine.
"""
import math

import pygame

from capas import suave

DUR = {"durmiendose": 3.8, "despertando": 3.0}
FPS_DORMIDA = 8
INDIGO, LAVANDA, BANDA = (62, 66, 132), (150, 150, 214), (250, 244, 232)
SOMBRA = (44, 46, 100)
W = 480
ALTO_GORRO = 130                       # px lógicos del dibujo del gorrito (incluye el pompón)
MARGEN = 16                            # sobra por arriba: al bajar o rebotar no deja ver piel sobre el gorrito
SUBE = 140                             # cuánto se esconde el gorrito arriba de la pantalla
RESPIRA_DORMIDA, RESPIRA_DESPIERTA = (3.0, 6.5), (1.6, 4.2)
DORMIDA = {"arco_ojos": 1.0, "rubor": 1.15, "subir": -2, "boca.sonrisa": 0.45, "boca.ancho": 0.55}

# (segundo, expresión, duración de la transición)
PASOS = {
    "durmiendose": [
        (0.0, {"ojos.sup": 0.35, "boca.apertura": 0.25, "boca.sonrisa": 0.5, "boca.ancho": 0.8}, 0.6),
        (0.6, {"ojos.sup": 0.65, "boca.apertura": 0.75, "boca.sonrisa": 0.3, "boca.ancho": 0.75, "subir": 4}, 0.6),
        (1.5, {"ojos.sup": 0.5, "boca.sonrisa": 0.7, "boca.ancho": 0.8}, 0.6),
        (2.3, {"ojos.sup": 0.85, "ojos.sup_curva": 0.2, "boca.sonrisa": 0.6, "boca.ancho": 0.7, "rubor": 1.2}, 0.6),
        (3.1, DORMIDA, 0.5),
    ],
    "despertando": [
        (0.0, {"ojos.sup": 0.75, "boca.sonrisa": 0.6, "boca.ancho": 0.7}, 0.5),
        (0.6, {"ojos.escala": 1.1, "boca.sonrisa": 1.0, "boca.apertura": 0.2}, 0.5),
        (1.3, {"arco_ojos": -1.0, "subir": 8, "boca.apertura": 0.45, "boca.sonrisa": 1.3, "rubor": 1.5}, 0.4),
        (2.1, {"subir": 3, "boca.sonrisa": 1.3, "rubor": 1.3, "ojos.escala": 1.05}, 0.4),
    ],
}
GORRO = {"durmiendose": (1.5, 2.7), "despertando": (2.0, 2.7)}


def _bez(p0, p1, p2, n=40):
    return [((1 - t) ** 2 * p0[0] + 2 * t * (1 - t) * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * t * (1 - t) * p1[1] + t * t * p2[1]) for t in (i / n for i in range(n + 1))]


class Sueno:
    def __init__(self):
        self.estado = "despierta"
        self.t0 = 0.0
        self.i_paso = 0
        self.pendiente = None
        self._dibujos: dict[int, tuple] = {}

    @property
    def activo(self) -> bool:
        return self.estado != "despierta"

    def orden(self, orden: str, t: float) -> bool:
        """Devuelve True si arranca una animación; en plena animación la orden queda pendiente."""
        if self.estado in DUR:
            self.pendiente = orden
            return False
        arranca = {("dormir", "despierta"): "durmiendose", ("despertar", "dormida"): "despertando"}.get((orden, self.estado))
        if arranca:
            self.estado, self.t0, self.i_paso = arranca, t, 0
        return bool(arranca)

    def pasos(self, t: float) -> list[tuple[dict, float]]:
        """Pasos de la animación que tocan en este cuadro."""
        lista = PASOS.get(self.estado, [])
        salen = []
        while self.i_paso < len(lista) and t - self.t0 >= lista[self.i_paso][0]:
            salen.append(lista[self.i_paso][1:])
            self.i_paso += 1
        return salen

    def termino(self, t: float) -> bool:
        if self.estado not in DUR or t - self.t0 < DUR[self.estado]:
            return False
        self.estado = "dormida" if self.estado == "durmiendose" else "despierta"
        return True

    def gorro(self, t: float) -> float:
        """0 escondido … 1 puesto; al caer da un rebotico."""
        if self.estado == "dormida":
            return 1.0
        if self.estado not in GORRO:
            return 0.0
        ini, fin = GORRO[self.estado]
        f = (t - self.t0 - ini) / (fin - ini)
        if self.estado == "despertando":
            return 1.0 - suave(f)
        return 0.0 if f <= 0 else 1.0 if f >= 1 else suave(f / 0.75) + 0.05 * math.sin(math.pi * f) * (f > 0.75)

    # ---------- dibujo (piezas fijas en caché: dormida debe costar poco) ----------
    def dibujar(self, L: pygame.Surface, ss: int, t: float, subir: float, zzz: bool = True):
        g = self.gorro(t)
        if g <= 0:
            return
        gorro, zs = self._piezas(ss)
        L.blit(gorro, (0, (-SUBE * (1 - g) - subir - MARGEN) * ss))
        if self.estado == "dormida" and zzz:
            self._zzz(L, ss, t, zs)

    @staticmethod
    def _zzz(L, ss, t, zs):
        for i, z in enumerate(zs):                      # aparecen una a una y suben despacio, sin transparencias
            f = ((t / 3.6) + 1 - i * 0.2) % 1.0
            if f < 0.75:
                L.blit(z, ((262 + i * 20) * ss, (160 - i * 26 - f * 8) * ss - z.get_height() / 2))

    def _piezas(self, ss: int):
        if ss not in self._dibujos:
            fuentes = [pygame.font.SysFont("helveticaneue,helvetica,dejavusans", (18 + i * 9) * ss, bold=True) for i in range(3)]
            self._dibujos[ss] = (self._hacer_gorro(ss), [f.render("z", True, INDIGO) for f in fuentes])
        return self._dibujos[ss]

    @staticmethod
    def _hacer_gorro(s: int) -> pygame.Surface:
        sup = pygame.Surface((W * s, (ALTO_GORRO + MARGEN) * s), pygame.SRCALPHA)
        p = lambda pts: [(x * s, (y + MARGEN) * s) for x, y in pts]
        borde = _bez((-30, 86), (240, 30), (510, 86))
        arriba = lambda x: 86 - (1 - ((x - 240) / 270) ** 2) * 28
        pygame.draw.polygon(sup, INDIGO, p(borde + [(510, -MARGEN), (-30, -MARGEN)]))
        for x0, x1 in ((30, 74), (140, 184), (250, 294)):
            alto = arriba(x0)
            pygame.draw.polygon(sup, LAVANDA, p([(x0, alto), (x1, arriba(x1)), (x1 + 30, -MARGEN), (x0 + 30, -MARGEN)]))
        pygame.draw.polygon(sup, (0, 0, 0, 0), p(borde + [(510, ALTO_GORRO + 10), (-30, ALTO_GORRO + 10)]))
        pygame.draw.polygon(sup, BANDA, p([(x, y - 20) for x, y in borde] + borde[::-1]))
        cola = _bez((372, 16), (470, -6), (447, 84), 60)
        for i, (x, y) in enumerate(cola):
            f = i / 60
            pygame.draw.circle(sup, LAVANDA if int(f * 5) % 2 else INDIGO, (x * s, (y + MARGEN) * s), (25 - 15 * f) * s)
        pygame.draw.circle(sup, SOMBRA, (447 * s, (97 + MARGEN) * s), 22 * s)
        pygame.draw.circle(sup, BANDA, (447 * s, (96 + MARGEN) * s), 21 * s)
        return sup
