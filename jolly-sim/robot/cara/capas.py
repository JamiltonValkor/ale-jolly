"""Capas de vida de la cara (CV-006). La cara de cada cuadro = expresión base (con transición suave)
+ gesto en curso + mirada con dardos + parpadeo + respiración + boca por volumen.

Números (discussion/02): parpadeo ≈330 ms (100 cierra / 200 abre), reposo cada 4–9 s, escucha 2,5–6 s, 12 % dobles;
dardos de mirada cada 1–2,25 s; respiración lenta. Todo con semilla para pruebas reproducibles.
"""
import math, random

from parametros import NEUTRA, acotar, claves, expandir

PARPADEO_INTERVALO = {"reposo": (4.0, 9.0), "escucha": (2.5, 6.0), "hablando": (3.0, 7.0), "pensando": (3.5, 8.0)}
P_DOBLE = 0.12
CIERRA, ABRE = 0.10, 0.20
VEL_MAX = 7.0                       # unidades/s (≈0,12 por cuadro a 60 fps)
ESCALA = {"ladeo": 15.0, "boca.tilt": 15.0, "subir": 15.0}


def suave(f: float) -> float:
    """ease in-out (sin aceleraciones bruscas)."""
    f = min(max(f, 0.0), 1.0)
    return 0.5 - 0.5 * math.cos(math.pi * f)


class Transicion:
    def __init__(self, desde: dict, hacia: dict, t0: float, dur: float):
        self.desde, self.hacia, self.t0, self.dur = desde, hacia, t0, max(dur, 1e-3)

    def valor(self, t: float) -> dict:
        f = suave((t - self.t0) / self.dur)
        return {k: self.desde[k] + (self.hacia[k] - self.desde[k]) * f for k in self.desde}


class Animador:
    def __init__(self, semilla: int | None = None):
        self.rnd = random.Random(semilla)
        self.trans = Transicion(dict(NEUTRA), dict(NEUTRA), 0.0, 0.001)
        self.objetivo = dict(NEUTRA)
        self.gesto_pasos: list = []          # [(t_inicio, dur, cara_objetivo)] de un gesto temporal
        self.gesto_fin = None
        self.modo = "reposo"
        self.t_parpadeo = None               # inicio del parpadeo en curso
        self.prox_parpadeo = None
        self.dobles_pendientes = 0
        self.parpadeos: list[float] = []     # registro (pruebas)
        self.dardo = (0.0, 0.0); self.dardo_prev = (0.0, 0.0); self.t_dardo = 0.0; self.prox_dardo = 0.0
        self.amp_dardo = 0.35
        self.boca_extra = 0.0                # apertura que viene del volumen de la voz
        self.boca_redondez = 0.0             # 0 ancha ("a") … 1 redonda ("o")
        self.respiracion = (1.6, 4.2)        # (amplitud en px, período en s); dormida es más lenta y honda
        self.fase, self.t_fase = 0.0, None

    # ---------- órdenes ----------
    def ir_a(self, expr: dict, t: float, dur: float = 0.35):
        """Nueva expresión base (expr parcial sobre NEUTRA), empezando desde lo que se ve ahora."""
        self.objetivo = expandir(expr) if not set(expr) >= set(NEUTRA) else acotar(expr)
        actual = self.trans.valor(t)
        # cambios grandes duran más: el pico de la curva suave (π/2·Δ/dur) no pasa de VEL_MAX por segundo
        delta = max(abs(self.objetivo[k] - actual[k]) / ESCALA.get(k, 1.0) for k in actual if "abierto" not in k)
        dur = max(dur, math.pi / 2 * delta / VEL_MAX)
        self.trans = Transicion(actual, self.objetivo, t, dur)
        self.gesto_pasos, self.gesto_fin = [], None

    def gesto(self, pasos: list, t: float):
        """Secuencia temporal [(dur, expr_parcial_sobre_la_base_actual), …]; al final vuelve a la base."""
        base = dict(self.objetivo)
        cursor, lista = t, []
        for dur, parcial in pasos:
            meta = acotar({**base, **claves(parcial)})
            lista.append((cursor, dur, meta)); cursor += dur
        lista.append((cursor, 0.35, base))
        self.gesto_pasos, self.gesto_fin = lista, cursor + 0.35

    def modo_parpadeo(self, modo: str, t: float):
        if modo != self.modo:
            self.modo = modo
            self._programar(t)

    def parpadear(self, t: float, doble: bool = False):
        self.t_parpadeo, self.dobles_pendientes = t, (1 if doble else 0)

    def mirada_fija(self, fija: bool):
        self.amp_dardo = 0.07 if fija else 0.35

    # ---------- cuadro ----------
    def cuadro(self, t: float) -> dict:
        c = self.trans.valor(t)
        if self.gesto_pasos:                                      # gesto temporal encima de la base
            activo = [p for p in self.gesto_pasos if p[0] <= t]
            if activo and t < self.gesto_fin:
                t0, dur, meta = activo[-1]
                previo = self.gesto_pasos[len(activo) - 2][2] if len(activo) > 1 else c
                f = suave((t - t0) / dur)
                c = {k: previo[k] + (meta[k] - previo[k]) * f for k in c}
            elif t >= self.gesto_fin:
                self.trans = Transicion(c, self.objetivo, t, 0.001)
                self.gesto_pasos, self.gesto_fin = [], None
        c = dict(c)
        # dardos de mirada
        if t >= self.prox_dardo:
            self.dardo_prev, self.t_dardo = self._dardo_actual(t), t
            a = self.amp_dardo
            self.dardo = (self.rnd.uniform(-a, a), self.rnd.uniform(-a * 0.6, a * 0.6))
            self.prox_dardo = t + self.rnd.uniform(1.0, 2.25)
        dx, dy = self._dardo_actual(t)
        c["mirada_x"] += dx; c["mirada_y"] += dy
        # respiración
        amp, periodo = self.respiracion
        self.fase += 2 * math.pi * (t - self.t_fase) / periodo if self.t_fase is not None else 2 * math.pi * t / periodo
        self.t_fase = t
        c["subir"] += amp * math.sin(self.fase)
        # parpadeo
        k = self._parpadeo(t)
        c["oi.abierto"] *= k; c["od.abierto"] *= k
        # boca por voz (encima de la base)
        if self.boca_extra > c["boca.apertura"]:
            c["boca.apertura"] = self.boca_extra
            c["boca.ancho"] *= 1.0 + 0.12 * (1 - self.boca_redondez) - 0.3 * self.boca_redondez
        return acotar(c)

    def _dardo_actual(self, t):
        f = min(1.0, (t - self.t_dardo) / 0.06)                 # salto rápido (sacádico)
        return (self.dardo_prev[0] + (self.dardo[0] - self.dardo_prev[0]) * f,
                self.dardo_prev[1] + (self.dardo[1] - self.dardo_prev[1]) * f)

    def _programar(self, t):
        lo, hi = PARPADEO_INTERVALO.get(self.modo, (4.0, 9.0))
        self.prox_parpadeo = t + self.rnd.uniform(lo, hi)

    def _parpadeo(self, t: float) -> float:
        if self.prox_parpadeo is None:
            self._programar(t)
        if self.t_parpadeo is None and t >= self.prox_parpadeo:
            self.t_parpadeo = t
            self.dobles_pendientes = 1 if self.rnd.random() < P_DOBLE else 0
        if self.t_parpadeo is None:
            return 1.0
        e = t - self.t_parpadeo
        if not self.parpadeos or self.parpadeos[-1] != self.t_parpadeo:
            self.parpadeos.append(self.t_parpadeo)
        if e < CIERRA:
            return 1 - suave(e / CIERRA)
        if e < CIERRA + ABRE:
            return suave((e - CIERRA) / ABRE)
        if self.dobles_pendientes:
            self.dobles_pendientes -= 1
            self.t_parpadeo = t + 0.08
            return 1.0
        self.t_parpadeo = None
        self._programar(t)
        return 1.0
