"""Costo de IA por negocio y por día (OSB-004).

Un hook de httpx lee el bloque `usage` de cada respuesta de OpenRouter y lo
acumula para el negocio en curso (contextvar). Nunca registra el contenido.
"""

from __future__ import annotations

import contextvars
import json
from collections import defaultdict
from typing import Any

import httpx2 as httpx  # el cliente que usa openai>=3 (Graphiti y extract-lessons)

current_business: contextvars.ContextVar[str | None] = contextvars.ContextVar("current_business", default=None)


class UsageMeter:
    def __init__(self) -> None:
        self.totals: dict[str, dict[str, float]] = defaultdict(lambda: {"tokens": 0.0, "cost_usd": 0.0, "calls": 0.0})

    async def on_response(self, response: httpx.Response) -> None:
        business = current_business.get()
        if business is None or response.status_code >= 400:
            return
        try:
            await response.aread()
            body: Any = json.loads(response.content or b"{}")
        except (ValueError, httpx.HTTPError):
            return
        usage = body.get("usage") if isinstance(body, dict) else None
        if not isinstance(usage, dict):
            return
        bucket = self.totals[business]
        bucket["tokens"] += float(usage.get("total_tokens") or 0)
        bucket["cost_usd"] += float(usage.get("cost") or 0)
        bucket["calls"] += 1

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=httpx.Timeout(120.0), event_hooks={"response": [self.on_response]})

    def drain(self) -> dict[str, dict[str, float]]:
        out = {k: dict(v) for k, v in self.totals.items()}
        self.totals.clear()
        return out
