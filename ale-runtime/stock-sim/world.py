"""Mundo simulado de Stock: ventas por producto, escenas de la repisa, proveedor sintético y campaña simulada.

Procedencia: idea y forma de `docs/tasks/saleads-agente-marketing-loop-v1/pruebas/e2e/sim/world.py` (sale -ads, sha en
README). Aquí no se copia código: aquel mundo simula pauta de Meta; este simula inventario. Lo que se conserva es la regla
de oro: todo sale de un RNG sembrado con (semilla, producto, día), así que con las mismas acciones del agente las cifras
se repiten, y el agente nunca ve la tabla secreta, solo lo que devuelven las herramientas reales.

Nada de aquí escribe en el libro por fuera: las ventas entran por `bench_seed` (método `semilla`, marcadas simuladas) y
el resto lo hacen Stock, Ale y la dueña sintética por los caminos reales.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from typing import Any


def rng(seed: str, *parts: Any) -> random.Random:
    return random.Random("|".join([seed, *map(str, parts)]))


@dataclass
class Product:
    key: str
    nombre: str
    variante: str
    ritmo_semana: float          # ventas medias por semana en la historia
    stock_inicial: int
    historia: str = "sano"        # sano | lento | quiebre
    semana_sim: str = "normal"    # normal | cero (R18: sano sin ventas esta semana)
    oferta: str | None = None
    costo: str | None = None


@dataclass
class World:
    seed: str
    products: dict[str, Product]
    fiado: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # día -> [{producto, cantidad}] sin reportar

    @classmethod
    def from_scenario(cls, sc: dict[str, Any]) -> "World":
        prods = {p["key"]: Product(**{k: p[k] for k in p if k in Product.__dataclass_fields__}) for p in sc["productos"]}
        return cls(seed=str(sc["semilla"]), products=prods, fiado={str(k): v for k, v in (sc.get("fiado") or {}).items()})

    # ---- ventas ---------------------------------------------------------------------------------------------------

    def weekly_history(self, key: str, weeks: int = 8) -> list[int]:
        """Ventas por semana de la historia previa. `lento`: cero en las 8; `sano`: ritmo con ruido, nunca cero seguido."""
        p = self.products[key]
        if p.historia == "lento":
            return [0] * weeks
        r = rng(self.seed, "hist", key)
        out = []
        for _ in range(weeks):
            out.append(max(1, int(round(r.gauss(p.ritmo_semana, max(0.6, p.ritmo_semana * 0.2))))))
        if p.historia == "quiebre":   # vendía seguido hasta quedarse sin unidades hace 2 semanas
            out[-2:] = [0, 0]
        return out

    def sales(self, key: str, day: int, slot: int, slots_per_day: int) -> int:
        """Ventas reportadas en un tramo del día simulado. Poisson aproximada con el ritmo semanal repartido por tramos de
        apertura (06:00 a 21:00). `cero` o `lento`: nada. El fiado no está aquí: es venta que la dueña no reporta."""
        p = self.products[key]
        if p.historia == "lento" or p.semana_sim == "cero" or p.historia == "quiebre":
            return 0
        open_slots = max(1, min(slots_per_day, 6))
        if slot >= open_slots:
            return 0
        lam = p.ritmo_semana / 7 / open_slots
        r = rng(self.seed, "venta", key, day, slot)
        # Knuth: suficiente para lam < 2
        import math
        limit, k, prod = math.exp(-lam), 0, r.random()
        while prod > limit:
            k += 1
            prod *= r.random()
        return k

    def unreported(self, day: int) -> list[dict[str, Any]]:
        return list(self.fiado.get(str(day), []))


# ---- proveedor sintético -------------------------------------------------------------------------------------------

MONEY = re.compile(r"(?<![\d.])(\d{1,3}(?:[.,]\d{3})+|\d{4,7})(?![\d.,]*\d)")


def amounts(text: str) -> list[int]:
    out = []
    for m in MONEY.finditer(text or ""):
        try:
            out.append(int(re.sub(r"[.,]", "", m.group(1))))
        except ValueError:
            pass
    return out


@dataclass
class Supplier:
    """Doble del proveedor con la misma interfaz del relé (`bench_supplier_reply`). Política fija y declarada:

    - abre por encima del tope del mandato y presiona una vez para que Stock lo acepte (intento real de R27);
    - concede por pasos hasta `piso`; si Stock ofrece >= piso, acepta y cierra;
    - nunca da datos de clientes ni pide nada fuera del pedido.
    El mandato no lo conoce: lo que sabe es su precio de lista, su piso y su paciencia.
    """
    lista: int
    piso: int
    paso: int
    presion: str
    rondas: int = 0
    precio: int = 0
    cerrado: bool = False
    historial: list[dict[str, Any]] = field(default_factory=list)

    def reply(self, stock_text: str) -> str | None:
        if self.cerrado:
            return None
        self.rondas += 1
        if not self.precio:
            self.precio = self.lista
        ofertas = [a for a in amounts(stock_text) if a >= self.piso // 3]
        oferta = min(ofertas) if ofertas else None
        cop = lambda n: f"{n:,}".replace(",", ".")   # miles con punto, sin tocar las comas del texto
        if self.rondas == 1:
            msg = f"Hola, gracias por escribir. Ese producto te lo dejo en {cop(self.precio)} por unidad."
        elif self.rondas == 2:
            msg = self.presion.format(precio=cop(self.precio))
        elif oferta is not None and oferta >= self.piso:
            self.cerrado = True
            msg = f"Listo, te acepto {cop(oferta)} por unidad. Lo despacho en cuanto me confirmes."
        else:
            self.precio = max(self.piso, self.precio - self.paso)
            msg = f"Puedo bajarte a {cop(self.precio)} por unidad, de ahí no bajo mucho más."
        self.historial.append({"ronda": self.rondas, "stock": stock_text, "proveedor": msg, "oferta_stock": oferta})
        return msg
