import os
"""Dibuja la cara de Ale (480×320) a partir de los parámetros. Geometría medida en el dibujo de referencia,
igual que mini-muse/imprimir/cara/generar_cara.py (ojos ±0.254·FW·K, Ø0.105; sonrisa 0.158; rubor ±0.286; K=0.82).

Se dibuja supermuestreado (×SS) y se reduce con suavizado → bordes limpios sin depender de antialias por figura.
"""
import math

import pygame

from parametros import NEUTRA

W, H = 480, 320
PXMM = 480 / 73.4
FW, FH, K = 126.0, 96.0, 0.82
CREMA = (238, 222, 196)
NEGRO_OJO = (18, 14, 16)
BOCA = (30, 20, 22)
INTERIOR_BOCA = (92, 38, 46)
LENGUA = (226, 120, 128)
RUBOR = (242, 150, 155)
TRANSPARENTE = (0, 0, 0, 0)


def mm(x, y):
    """mm en la cara → px en 480×320 (sin supermuestreo)."""
    return 240 + x * PXMM, 160 + y * PXMM


OJO_X = 0.254 * FW * K * PXMM                 # 171.6 px desde el centro
OJO_Y = mm(0, -0.01 * FH * K)[1]              # 154.9
OJO_R = 0.0525 * FW * K * PXMM                # 35.5
BOCA_Y = mm(0, 0.14 * FH * K)[1]              # 232.1
BOCA_W = 0.158 * FW * K * PXMM                # 106.7
BOCA_GROSOR = 2.2 * PXMM * 0.6                # 8.6
RUBOR_X = 0.286 * FW * K * PXMM               # 193.2
RUBOR_RX, RUBOR_RY = 0.10 * FW * K * PXMM, 0.08 * FW * K * PXMM
RUBOR_BLUR = 11.0


class Render:
    def __init__(self, ss: int = 2, salida: tuple[int, int] = (W, H)):
        self.ss = ss
        self.lienzo = pygame.Surface((W * ss, H * ss))
        self.salida = pygame.Surface(salida)
        self._rubor = self._hacer_rubor()

    # ---------- piezas fijas ----------
    def _hacer_rubor(self) -> pygame.Surface:
        s = self.ss
        m = int(RUBOR_BLUR * 3 * s)
        sup = pygame.Surface((int(2 * RUBOR_RX * s) + 2 * m, int(2 * RUBOR_RY * s) + 2 * m), pygame.SRCALPHA)
        sup.fill((*RUBOR, 0))
        pygame.draw.ellipse(sup, (*RUBOR, 240), (m, m, int(2 * RUBOR_RX * s), int(2 * RUBOR_RY * s)))
        return pygame.transform.gaussian_blur(sup, int(RUBOR_BLUR * s))

    # ---------- cara ----------
    def dibujar(self, c: dict, burbujas=None, t: float = 0.0, encima=None) -> pygame.Surface:
        s = self.ss
        L = self.lienzo
        L.fill(CREMA)
        giro, ladeo = c["giro"], math.radians(c["ladeo"])
        cx0, cy0 = 240 * s, 190 * s                    # pivote del ladeo (centro de la carita)

        def pos(x, y, prof):
            """Posición (px de 480) → lienzo, con giro (profundidad `prof`), ladeo y respiración."""
            x += giro * prof
            y -= c["subir"]
            X, Y = x * s - cx0, y * s - cy0
            return cx0 + X * math.cos(ladeo) - Y * math.sin(ladeo), cy0 + X * math.sin(ladeo) + Y * math.cos(ladeo)

        # rubor (debajo de todo)
        a = max(0.0, min(1.0, c["rubor"] / 1.6))
        if a > 0.01:
            self._rubor.set_alpha(int(255 * a))
            for lado in (-1, 1):
                x, y = pos(240 + lado * RUBOR_X, BOCA_Y, 12)
                L.blit(self._rubor, (x - self._rubor.get_width() / 2, y - self._rubor.get_height() / 2))

        # ojos
        mx, my = c["mirada_x"] * 15, c["mirada_y"] * 10
        for lado, p in ((-1, "oi."), (1, "od.")):
            x, y = pos(240 + lado * OJO_X + mx, OJO_Y + my, 18)
            crece = 1 + 0.03 * giro * lado                # el ojo del lado al que gira se ve un poco más grande
            if abs(c["arco_ojos"]) > 0.5:
                self._arco_ojo(L, x, y, c["arco_ojos"] > 0)
            else:
                self._ojo(L, x, y, c, p, lado, crece, (mx, my))

        # boca
        x, y = pos(240 + c["boca.lado"] * BOCA_W * 0.35 + mx * 0.15, BOCA_Y + my * 0.15, 24)
        self._boca(L, x, y, c, math.degrees(ladeo))

        if os.path.exists("/tmp/jolly-cuernos"):         # rodaje: cuernos de diablito
            for lado in (-1, 1):
                def curva(a, c, b, n=10):
                    return [((1 - u) ** 2 * a[0] + 2 * (1 - u) * u * c[0] + u * u * b[0],
                             (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * c[1] + u * u * b[1]) for u in (k / n for k in range(n + 1))]
                afuera, adentro, punta = pos(240 + lado * 168, 96, 6), pos(240 + lado * 104, 84, 6), pos(240 + lado * 188, 6, 6)
                pts = curva(adentro, pos(240 + lado * 126, 34, 6), punta) + curva(punta, pos(240 + lado * 196, 62, 6), afuera)
                pygame.draw.polygon(L, (205, 32, 45), pts)
                pygame.draw.polygon(L, (110, 12, 20), pts, max(2, int(3 * s)))
        if encima is not None:                           # modo dormir: gorrito, zzz y botón
            encima(L, s)
        if burbujas is not None:                         # franja de arriba: qué está haciendo Ale
            burbujas.dibujar(L, s, t)
        pygame.transform.smoothscale(L, self.salida.get_size(), self.salida)
        return self.salida

    def _arco_ojo(self, L, cx, cy, dormido: bool):
        """Ojo cerrado ‿ (dormida) o feliz ⌒ (al estirarse)."""
        s = self.ss
        punta, centro = (-6, 32) if dormido else (12, -32)
        for i in range(61):
            u = i / 30 - 1                                 # parábola de la curva de Bézier de la maqueta aprobada
            pygame.draw.circle(L, NEGRO_OJO, (cx + 32 * u * s, cy + (punta + (centro - punta) * (1 - u * u) / 2) * s), 4.5 * s)

    def _ojo(self, L, cx, cy, c, p, lado, crece, mirada):
        s = self.ss
        esc = c[p + "escala"] * crece
        ab = max(c[p + "abierto"], 0.0)
        r = OJO_R * esc * s
        ryf = r * 1.04                                   # alto con el ojo abierto (los párpados se miden aquí)
        rx = r * (1 + 0.18 * max(0.0, 1 - ab))           # al cerrarse se estira un poquito (como Vector, suave)
        ry = ryf * max(ab, 0.07)
        w, h = int(2 * rx + 6), int(2 * ryf + 6)
        sup = pygame.Surface((w, h), pygame.SRCALPHA)
        sup.fill(TRANSPARENTE)
        mx, my = w / 2, h / 2
        pygame.draw.ellipse(sup, NEGRO_OJO, (mx - rx, my - ry, 2 * rx, 2 * ry))
        if ab > 0.45:                                    # brillo: se mueve un poco más que el ojo (vida)
            bx, by = mirada[0] * 0.5 * s, mirada[1] * 0.5 * s
            k = ry / ryf
            pygame.draw.ellipse(sup, (255, 255, 255), (mx - 0.55 * r + bx, my - 0.72 * r * k + by, 0.5 * r, 0.5 * r * k))
        adentro = -lado                                  # ojo izquierdo: adentro es +x
        n = 24
        if c[p + "sup"] > 0 or c[p + "sup_ang"] or c[p + "sup_curva"]:
            y0 = my - ryf + c[p + "sup"] * ryf
            t = math.tan(math.radians(c[p + "sup_ang"]))
            pts = []
            for i in range(n + 1):
                x = -2 + (w + 4) * i / n
                u = (x - mx) / rx
                pts.append((x, y0 + t * (x - mx) * adentro + c[p + "sup_curva"] * max(0.0, 1 - u * u) * ryf * 0.5))
            pygame.draw.polygon(sup, TRANSPARENTE, pts + [(w + 2, -2), (-2, -2)])
        if c[p + "inf"] > 0 or c[p + "inf_curva"]:
            y1 = my + ryf - c[p + "inf"] * ryf
            pts = []
            for i in range(n + 1):
                x = -2 + (w + 4) * i / n
                u = (x - mx) / rx
                pts.append((x, y1 - c[p + "inf_curva"] * max(0.0, 1 - u * u) * ryf * 0.6))
            pygame.draw.polygon(sup, TRANSPARENTE, pts + [(w + 2, h + 2), (-2, h + 2)])
        L.blit(sup, (cx - mx, cy - my))

    def _boca(self, L, cx, cy, c, ladeo_deg):
        s = self.ss
        sonr, ap = c["boca.sonrisa"], c["boca.apertura"]
        a = BOCA_W / 2 * c["boca.ancho"] * s
        b = 0.35 * BOCA_W * max(sonr, 0.02) * s
        yc = cy - 0.1 * BOCA_W * sonr * s            # centro de la elipse del arco (como el PIL de referencia)
        tilt = math.radians(c["boca.tilt"] + ladeo_deg)

        def rot(x, y):
            X, Y = x - cx, y - cy
            return cx + X * math.cos(tilt) - Y * math.sin(tilt), cy + X * math.sin(tilt) + Y * math.cos(tilt)

        grosor = max(2, int(BOCA_GROSOR * s))
        ac, bc = a - grosor / 2, max(b - grosor / 2, 1.0)  # PIL dibuja el grosor hacia adentro del arco
        arco = [rot(cx + ac * math.cos(math.radians(th)), yc + bc * math.sin(math.radians(th))) for th in range(20, 161, 4)]
        if ap > 0.03:
            # boca abierta kawaii: el arco es el borde de arriba y baja una "D" proporcional a la apertura
            prof = ap * 0.55 * BOCA_W * s
            arriba = [(x, y - grosor * 0.3) for x, y in arco]
            abajo = []
            for th in range(160, 19, -5):
                u = math.cos(math.radians(th)) / math.cos(math.radians(20))
                x = cx + ac * math.cos(math.radians(th))
                y = yc + bc * math.sin(math.radians(th)) + prof * max(0.0, 1 - u * u) ** 0.7
                abajo.append(rot(x, y))
            pygame.draw.polygon(L, INTERIOR_BOCA, arriba + abajo)
            if ap > 0.35:                                  # lengüita
                lx, ly = rot(cx, yc + bc + prof * 0.55)
                pygame.draw.ellipse(L, LENGUA, (lx - ac * 0.42, ly - prof * 0.22, ac * 0.84, prof * 0.42))
            pygame.draw.lines(L, BOCA, True, arriba + abajo, max(2, grosor // 2))
        self._trazo(L, arco, grosor)

    @staticmethod
    def _trazo(L, pts, grosor):
        """Línea gruesa con puntas planas (como el arco de referencia), sin huecos en las uniones."""
        izq, der = [], []
        for i, (x, y) in enumerate(pts):
            x0, y0 = pts[max(i - 1, 0)]
            x1, y1 = pts[min(i + 1, len(pts) - 1)]
            dx, dy = x1 - x0, y1 - y0
            n = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / n * grosor / 2, dx / n * grosor / 2
            izq.append((x + nx, y + ny)); der.append((x - nx, y - ny))
        pygame.draw.polygon(L, BOCA, izq + der[::-1])


def cara_neutra_surface(ss: int = 3) -> pygame.Surface:
    return Render(ss).dibujar(dict(NEUTRA))
