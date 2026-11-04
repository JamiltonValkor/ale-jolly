"""Boca por la voz real (CV-008, v2 tras la sesión real del 27-oct).

v1 seguía el volumen absoluto y quedó abierta el 92 % del tiempo (la voz de Cartesia es pareja y fuerte). v2 sigue el
RITMO DE LAS SÍLABAS: cuánto sobresale el volumen de su promedio reciente (~0,2 s) + un poco del volumen absoluto.
Calibrado con el volumen grabado de esa sesión: abierta ~68 % del habla, apertura media ~0,36, ~3,4 cierres/s.
También cambia la FORMA: al abrir (subida) más ancha ("a"), al sostener/bajar más redonda ("o").

Recibe lotes `voz/volumen {t0, dt, niveles[]}` con la hora en que cada nivel SUENA; adelanto visual ~25 ms.
"""
import bisect, math

K_BASE, K_SILABA = 0.2, 1.5
TAU_LENTO = 0.2
ATAQUE, CAIDA = 0.020, 0.080
UMBRAL = 0.30                        # bajo esto la boca se ve cerrada (entre sílabas)
ADELANTO = 0.025
APERTURA_MAX = 0.85                  # boca pequeña de Muse


class Boca:
    def __init__(self):
        self.ts: list[float] = []
        self.niveles: list[float] = []
        self.valor = 0.0
        self.lento = 0.0
        self.objetivo = 0.0
        self.t_prev = None

    def agregar(self, t0: float, dt: float, niveles: list[float]):
        for i, n in enumerate(niveles):
            t = t0 + i * dt
            if self.ts and t <= self.ts[-1]:
                continue
            self.ts.append(t); self.niveles.append(float(n))
        if len(self.ts) > 6000:                                   # ~1 min de historia
            self.ts, self.niveles = self.ts[-3000:], self.niveles[-3000:]

    def nivel(self, t: float) -> float:
        i = bisect.bisect_right(self.ts, t) - 1
        if i < 0 or t - self.ts[i] > 0.05:                         # sin datos para esa hora → silencio
            return 0.0
        return self.niveles[i]

    def actualizar(self, t: float) -> tuple[float, float]:
        """(apertura 0–APERTURA_MAX, redondez 0–1) para la hora `t` del cuadro."""
        nivel = self.nivel(t + ADELANTO)
        dt = 0.0 if self.t_prev is None else min(0.1, max(0.0, t - self.t_prev))
        self.t_prev = t
        if dt:
            self.lento += (nivel - self.lento) * (1 - math.exp(-dt / TAU_LENTO))
        silaba = max(0.0, nivel - 0.85 * self.lento)
        base = min(1.0, max(0.0, (nivel - 0.45) / 0.55))
        self.objetivo = min(1.0, K_BASE * base ** 1.5 + K_SILABA * silaba)
        if dt:
            tau = ATAQUE if self.objetivo > self.valor else CAIDA
            self.valor += (self.objetivo - self.valor) * (1 - math.exp(-dt / tau))
        if self.valor < UMBRAL:
            return 0.0, 0.0
        apertura = min(APERTURA_MAX, (self.valor - UMBRAL) / (1 - UMBRAL) * APERTURA_MAX * 1.25 + 0.12)
        redondez = min(1.0, max(0.0, (self.valor - self.objetivo) * 3.0))   # sosteniendo/bajando → "o"
        return apertura, redondez

    def apertura(self, t: float) -> float:
        return self.actualizar(t)[0]
