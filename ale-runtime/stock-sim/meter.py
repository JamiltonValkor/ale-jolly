"""Gasto de la corrida en US$: modelo de la VM, SAM, extracción y la dueña sintética (Muse).

Procedencia: forma de `e2e/sim/meter.py` (gasto por vuelta). Precios de lista de esta ola, no de factura:
- Muse Contributor (Hermes de la VM y la dueña): US$ 0,10 por millón de entrada y 0,20 de salida (progress.md, IVB-021).
  La caché leída se cuenta a precio de entrada: cota alta, porque no hay precio publicado de caché.
- SAM 3.1: US$ 0,0025 por llamada; extracción de factura con Muse: se cuenta como una llamada de 50.000 tokens.
- Muse Image: 0 (la repisa usa imágenes ya generadas en IVB-022).

Lo que la API de Hermes no ve: los workers del perfil `stock` guardan sus sesiones en `profiles/stock/state.db`, que la
API del perfil por defecto no lista. Se estiman por tarjeta Stock (`tarjetas_stock` usado) a 136.000 de entrada y
6.000 de salida (techo de S-30 por turno), y se dicen como estimado.
"""

from __future__ import annotations

from typing import Any

PRICE_IN, PRICE_OUT = 0.10, 0.20
SAM_USD = 0.0025
EXTRACT_TOKENS = 50_000
STOCK_CARD_IN, STOCK_CARD_OUT = 136_000, 6_000


def usd(tokens_in: float, tokens_out: float) -> float:
    return tokens_in / 1e6 * PRICE_IN + tokens_out / 1e6 * PRICE_OUT


def baseline(vm) -> dict[str, list[int]]:
    """Tokens acumulados de cada sesión al empezar: la sesión principal del dueño vive días y sus contadores no se reinician."""
    return {s["id"]: [s["input_tokens"], s["output_tokens"], s["cache_read_tokens"]] for s in vm.sessions(0)}


def spend(vm, since_epoch: float, owner, sql, run_id: str, base: dict[str, list[int]] | None = None) -> dict[str, Any]:
    sessions = vm.sessions(since_epoch - 5)
    base = base or {}
    delta = lambda s, i, k: max(0, s[k] - (base.get(s["id"]) or [0, 0, 0])[i])
    ale_in = sum(delta(s, 0, "input_tokens") for s in sessions)
    ale_out = sum(delta(s, 1, "output_tokens") for s in sessions)
    ale_cache = sum(delta(s, 2, "cache_read_tokens") for s in sessions)
    try:
        budgets = {b["metric"]: int(float(b["used"])) for b in sql.query("SELECT metric, used FROM assistant.stock_run_budgets WHERE run_id = $1", [run_id])}
    except Exception:  # noqa: BLE001 — sin presupuesto legible, el gasto de Stock queda en cero y se dice
        budgets = {}
    cards = budgets.get("tarjetas_stock", 0)
    sam = budgets.get("sam_llamadas", 0)
    extract = budgets.get("extraccion", 0)
    vm_usd = usd(ale_in + ale_cache, ale_out)
    vm_usd_sin_cache = usd(ale_in, ale_out)
    stock_usd = usd(cards * STOCK_CARD_IN, cards * STOCK_CARD_OUT)
    owner_usd = owner.cost_usd()
    total = vm_usd + stock_usd + owner_usd + sam * SAM_USD + extract * usd(EXTRACT_TOKENS, 2_000)
    return {"sesiones_vm": len(sessions), "vm_in": ale_in, "vm_out": ale_out, "vm_cache": ale_cache, "vm_usd": round(vm_usd, 4), "vm_usd_sin_cache": round(vm_usd_sin_cache, 4),
            "tarjetas_stock": cards, "stock_usd_estimado": round(stock_usd, 4), "sam_llamadas": sam, "sam_usd": round(sam * SAM_USD, 4),
            "extraccion": extract, "dueno_in": owner.usage["input_tokens"], "dueno_out": owner.usage["output_tokens"], "dueno_usd": round(owner_usd, 4),
            "tokens_ale_corrida": budgets.get("tokens_ale"), "total_usd": round(total, 4)}
