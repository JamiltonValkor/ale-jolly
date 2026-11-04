"""Burbujas y animaciones en la franja libre de arriba (y 0–110 px): muestran QUÉ está haciendo Ale (principio de
Jolly: el indicador de estado). La cara no se mueve; las burbujas entran y salen con un "pop" (escala con rebote),
sin transparencias, para que se vean igual en la pantalla real.

  nube      pensando (• • •) / pensando largo (• • • más rápido) / trabajando (ícono de la herramienta)
  foco      💡 "¡ya sé!" entre pensar y responder
  destellos ✨ con buenas noticias (feliz / orgullosa)
  pregunta  "?" cuando está confundida o algo falló
  ondas     ))) suaves al empezar a escuchar
  zzz       durante el bostecito
"""
import math

import pygame

FONDO_BURBUJA = (255, 251, 244)
TRAZO = (112, 88, 76)
ROSA = (238, 138, 150)
AMARILLO = (247, 196, 84)
CAFE_SUAVE = (168, 136, 118)
ENTRA, SALE = 0.32, 0.22

ICONO_POR_HERRAMIENTA = [  # (fragmentos del nombre de la herramienta, ícono)
    (("result", "metric", "health", "sales", "box", "overview", "growth", "cycle"), "grafica"),
    (("update", "create", "set_", "submit", "approve", "copies", "images"), "lapiz"),
    (("campaign", "ads", "plan", "strategy", "launch", "special"), "megafono"),
]


def icono_para(herramienta: str | None) -> str:
    n = (herramienta or "").lower()
    for claves, icono in ICONO_POR_HERRAMIENTA:
        if any(k in n for k in claves):
            return icono
    return "lupa"


def _pop(e: float) -> float:
    """0→1 con un rebote suave (overshoot) en ENTRA segundos."""
    if e <= 0:
        return 0.0
    f = min(1.0, e / ENTRA)
    return 1 + 2.2 * (f - 1) ** 3 + 1.2 * (f - 1) ** 2 if f < 1 else 1.0


class Burbujas:
    def __init__(self):
        self.activos: dict[str, dict] = {}
        self._fuentes: dict[int, pygame.font.Font] = {}

    # ---------- control ----------
    def mostrar(self, nombre: str, t: float, dur: float | None = None, **datos):
        a = self.activos.get(nombre)
        if a and a.get("t_sale") is None and a.get("datos") == datos:
            if dur:
                a["t_sale"] = t + dur
            return
        cont = a is not None and a.get("t_sale") is None             # cambiar contenido sin re-entrar (nube)
        self.activos[nombre] = {"t0": a["t0"] if cont else t, "t_sale": (t + dur) if dur else None, "datos": datos}

    def ocultar(self, nombre: str, t: float):
        a = self.activos.get(nombre)
        if a and (a["t_sale"] is None or a["t_sale"] > t):
            a["t_sale"] = t

    def visibles(self, t: float) -> list[str]:
        return [n for n, a in self.activos.items() if self._escala(a, t) > 0.01]

    def _escala(self, a: dict, t: float) -> float:
        s = _pop(t - a["t0"])
        if a["t_sale"] is not None and t > a["t_sale"]:
            s *= max(0.0, 1 - (t - a["t_sale"]) / SALE)
        return s

    # ---------- dibujo ----------
    def dibujar(self, L: pygame.Surface, ss: int, t: float):
        for nombre in list(self.activos):
            a = self.activos[nombre]
            s = self._escala(a, t)
            if a["t_sale"] is not None and t > a["t_sale"] + SALE:
                del self.activos[nombre]
                continue
            if s > 0.01:
                getattr(self, "_" + nombre)(L, ss, t - a["t0"], s, **a["datos"])

    def _fuente(self, px: int) -> pygame.font.Font:
        px = max(8, int(px))
        if px not in self._fuentes:
            self._fuentes[px] = pygame.font.SysFont("Helvetica", px, bold=True)
        return self._fuentes[px]

    @staticmethod
    def _p(x, y, ss):
        return x * ss, y * ss

    def _nube(self, L, ss, e, s, contenido="puntos", rapido=False):
        # estela de bolitas desde el ojo derecho hacia la nube (aparecen en orden)
        for i, (x, y, r) in enumerate(((404, 112, 4), (394, 99, 6), (381, 84, 8))):
            si = min(1.0, max(0.0, (e - i * 0.07) / 0.15)) * min(1.0, s)
            if si > 0:
                pygame.draw.circle(L, FONDO_BURBUJA, self._p(x, y, ss), r * si * ss)
                pygame.draw.circle(L, TRAZO, self._p(x, y, ss), r * si * ss, max(1, int(1.6 * ss)))
        sn = _pop(e - 0.2) * s
        if sn <= 0.01:
            return
        cx, cy = 318, 52
        lobulos = ((-34, 6, 20), (-14, -10, 24), (12, -12, 25), (36, 2, 21), (14, 14, 22), (-14, 14, 21))
        for dx, dy, r in lobulos:                                   # contorno
            pygame.draw.circle(L, TRAZO, self._p(cx + dx * sn, cy + dy * sn, ss), (r + 1.8) * sn * ss)
        for dx, dy, r in lobulos:                                   # relleno
            pygame.draw.circle(L, FONDO_BURBUJA, self._p(cx + dx * sn, cy + dy * sn, ss), r * sn * ss)
        if contenido == "puntos":
            vel = 7.5 if rapido else 4.5
            for i in range(3):
                salto = max(0.0, math.sin(e * vel - i * 0.9)) * 6
                pygame.draw.circle(L, CAFE_SUAVE, self._p(cx - 16 + i * 16, cy + 3 - salto * sn, ss), 4.2 * sn * ss)
        else:
            getattr(self, "_icono_" + contenido)(L, ss, e, sn, cx, cy + 2)

    def _icono_grafica(self, L, ss, e, s, cx, cy):
        for i, (h, c) in enumerate(((0.45, CAFE_SUAVE), (0.7, ROSA), (1.0, AMARILLO))):
            hh = 26 * s * (0.55 + 0.45 * h * (0.75 + 0.25 * math.sin(e * 3 + i)))
            x = cx - 18 + i * 13
            pygame.draw.rect(L, c, (x * ss, (cy + 13 * s - hh) * ss, 10 * s * ss, hh * ss), border_radius=int(2 * ss))
        pygame.draw.line(L, TRAZO, self._p(cx - 22, cy + 13 * s, ss), self._p(cx + 22, cy + 13 * s, ss), max(1, int(2 * ss)))

    def _icono_megafono(self, L, ss, e, s, cx, cy):
        pts = [(-16, -5), (2, -12), (2, 12), (-16, 5)]
        pygame.draw.polygon(L, ROSA, [self._p(cx + x * s, cy + y * s, ss) for x, y in pts])
        pygame.draw.polygon(L, TRAZO, [self._p(cx + x * s, cy + y * s, ss) for x, y in pts], max(1, int(1.6 * ss)))
        for k in range(3):
            f = (e * 1.6 + k / 3) % 1.0
            r = (8 + 12 * f) * s
            rect = pygame.Rect(0, 0, 2 * r * ss, 2 * r * ss); rect.center = self._p(cx + 4 * s, cy, ss)
            if f < 0.85:
                pygame.draw.arc(L, TRAZO, rect, -0.7, 0.7, max(1, int(1.8 * ss)))

    def _icono_lapiz(self, L, ss, e, s, cx, cy):
        avance = (e * 0.9) % 1.0
        x0 = cx - 18 * s
        pts = [self._p(x0 + 36 * s * k / 12, cy + 8 * s + 3 * s * math.sin(k * 1.7), ss) for k in range(int(12 * avance) + 1)]
        if len(pts) > 1:
            pygame.draw.lines(L, CAFE_SUAVE, False, pts, max(1, int(2 * ss)))
        px, py = (x0 + 36 * s * avance, cy + 8 * s)
        cuerpo = [(px, py), (px + 5 * s, py - 6 * s), (px + 17 * s, py - 18 * s), (px + 12 * s, py - 23 * s), (px - 0 * s, py - 11 * s)]
        pygame.draw.polygon(L, AMARILLO, [self._p(x, y, ss) for x, y in cuerpo])
        pygame.draw.polygon(L, TRAZO, [self._p(x, y, ss) for x, y in cuerpo], max(1, int(1.4 * ss)))

    def _icono_lupa(self, L, ss, e, s, cx, cy):
        dx = 10 * math.sin(e * 2.2) * s
        pygame.draw.circle(L, FONDO_BURBUJA, self._p(cx + dx - 3, cy - 3, ss), 10 * s * ss)
        pygame.draw.circle(L, TRAZO, self._p(cx + dx - 3, cy - 3, ss), 10 * s * ss, max(1, int(2.2 * ss)))
        pygame.draw.line(L, TRAZO, self._p(cx + dx + 4 * s, cy + 4 * s, ss), self._p(cx + dx + 12 * s, cy + 12 * s, ss),
                         max(1, int(3.2 * ss)))

    def _foco(self, L, ss, e, s):
        cx, cy = 240, 50
        brillo = 0.5 + 0.5 * math.sin(e * 9)
        for k in range(8):                                          # rayos
            ang = k * math.pi / 4
            r0, r1 = 24 * s, (32 + 5 * brillo) * s
            pygame.draw.line(L, AMARILLO, self._p(cx + r0 * math.cos(ang), cy - 4 + r0 * math.sin(ang), ss),
                             self._p(cx + r1 * math.cos(ang), cy - 4 + r1 * math.sin(ang), ss), max(1, int(3 * ss)))
        pygame.draw.circle(L, AMARILLO, self._p(cx, cy - 4, ss), 16 * s * ss)
        pygame.draw.circle(L, TRAZO, self._p(cx, cy - 4, ss), 16 * s * ss, max(1, int(1.8 * ss)))
        pygame.draw.circle(L, FONDO_BURBUJA, self._p(cx - 5 * s, cy - 9 * s, ss), 4 * s * ss)
        pygame.draw.rect(L, CAFE_SUAVE, ((cx - 7 * s) * ss, (cy + 11 * s) * ss, 14 * s * ss, 8 * s * ss),
                         border_radius=int(2 * ss))

    def _destellos(self, L, ss, e, s):
        for i, (x, y, r) in enumerate(((92, 72, 9), (150, 34, 7), (332, 32, 8), (392, 74, 10), (240, 22, 6))):
            f = max(0.0, math.sin(e * 6 + i * 1.3))
            rr = r * s * (0.55 + 0.45 * f)
            c = AMARILLO if i % 2 == 0 else ROSA
            pts = []
            for k in range(8):
                ang = k * math.pi / 4
                rad = rr if k % 2 == 0 else rr * 0.32
                pts.append(self._p(x + rad * math.cos(ang), y + rad * math.sin(ang), ss))
            pygame.draw.polygon(L, c, pts)

    def _pregunta(self, L, ss, e, s):
        y = 52 + 4 * math.sin(e * 3.2)
        txt = self._fuente(46 * s * ss).render("?", True, TRAZO)
        L.blit(txt, txt.get_rect(center=self._p(372, y, ss)))

    def _ondas(self, L, ss, e, s):
        for lado in (-1, 1):
            cx = 240 + lado * 215
            for k in range(3):
                f = (e * 1.4 + k / 3) % 1.0
                r = (10 + 16 * f) * s
                rect = pygame.Rect(0, 0, 2 * r * ss, 2 * r * ss); rect.center = self._p(cx, 92, ss)
                a0 = -0.6 if lado > 0 else math.pi - 0.6
                if f < 0.8:
                    pygame.draw.arc(L, CAFE_SUAVE, rect, a0, a0 + 1.2, max(1, int(1.8 * ss)))

    def _zzz(self, L, ss, e, s):
        for i in range(3):
            f = ((e * 0.6) + i / 3) % 1.0
            txt = self._fuente((14 + 12 * f) * s * ss).render("z", True, CAFE_SUAVE)
            L.blit(txt, txt.get_rect(center=self._p(330 + 30 * f + i * 4, 92 - 70 * f, ss)))
