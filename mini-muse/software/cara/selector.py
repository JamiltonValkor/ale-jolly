"""Elige variantes del catálogo sin que se vuelva monótono (CV-007): por peso, con enfriamiento, nunca la misma
dos veces seguidas, y con jitter ±5–10 % para que ni la misma variante salga idéntica."""
import os, random

import yaml

from parametros import claves

AQUI = os.path.dirname(os.path.abspath(__file__))


def cargar(ruta: str = os.path.join(AQUI, "catalogo.yaml")) -> dict:
    with open(ruta, encoding="utf-8") as f:
        cat = yaml.safe_load(f)
    for grupo in ("momentos", "emociones"):
        for lista in cat[grupo].values():
            for v in lista:
                claves(v.get("expr", {}))                    # valida nombres de parámetros al cargar
    return cat


class Selector:
    def __init__(self, catalogo: dict | None = None, semilla: int | None = None):
        self.cat = catalogo or cargar()
        self.rnd = random.Random(semilla)
        self.ultima: dict[str, str] = {}
        self.usada: dict[str, float] = {}

    def elegir(self, lista: list, clave: str, t: float, forzar: str | None = None) -> dict:
        if forzar:
            v = next(v for v in lista if v["nombre"] == forzar)
        else:
            libres = [v for v in lista if v.get("peso", 1) > 0 and v["nombre"] != self.ultima.get(clave)
                      and t - self.usada.get(f"{clave}/{v['nombre']}", -1e9) >= v.get("enfriamiento", 0)]
            if not libres:
                libres = [v for v in lista if v.get("peso", 1) > 0 and v["nombre"] != self.ultima.get(clave)] \
                    or [v for v in lista if v.get("peso", 1) > 0] or lista
            v = self.rnd.choices(libres, weights=[max(v.get("peso", 1), 1e-6) for v in libres])[0]
        self.ultima[clave] = v["nombre"]
        self.usada[f"{clave}/{v['nombre']}"] = t
        return {**v, "expr": self._jitter(v.get("expr", {}))}

    def momento(self, nombre: str, t: float, forzar: str | None = None) -> dict:
        return self.elegir(self.cat["momentos"][nombre], f"m/{nombre}", t, forzar)

    def emocion(self, nombre: str, t: float) -> dict:
        return self.elegir(self.cat["emociones"].get(nombre) or self.cat["emociones"]["neutral"], f"e/{nombre}", t)

    def micro_gesto(self, t: float, inactivo_s: float) -> dict:
        lista = [g for g in self.cat["micro_gestos"] if inactivo_s >= g.get("tras_inactividad", 0)]
        return self.elegir(lista, "micro", t)

    def _jitter(self, expr: dict) -> dict:
        out = {}
        for k, v in expr.items():
            v = float(v)
            if k.endswith(("mirada_x", "mirada_y", "ladeo", "boca.lado", "boca.tilt", "giro")):
                out[k] = v + self.rnd.uniform(-0.08, 0.08) * (15 if "ladeo" in k or "tilt" in k else 1)
            else:
                out[k] = v * (1 + self.rnd.uniform(-0.07, 0.07))
        if "boca.sonrisa" in out:
            out["boca.sonrisa"] = max(0.0, out["boca.sonrisa"])
        return out
