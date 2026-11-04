"""extract-lessons: lecciones abstractas de lo que el dueño dijo o decidió (ADR0020).

Corre en la VM, con la IA del dueño. Las lecciones quedan pendientes en el
ledger; un job con agente las comparte por el MCP (`saleads_share_learning`)
con la credencial de Hermes. Antes de guardarlas se descarta cualquier lección
con datos personales, cifras o nombres del negocio y sus productos.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from contextlib import closing
from typing import Any

from saleads_brain.ledger import Ledger

CHECKPOINT = "lessons:events"
MAX_LESSONS = 3

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
DIGITS = re.compile(r"\d{3,}|\d[\d.,]*\s*(?:%|usd|cop|mxn|\$)", re.IGNORECASE)
URL = re.compile(r"https?://|www\.", re.IGNORECASE)

PROMPT = (
    "Eres un analista de marketing. A partir de lo que dijo o decidió el dueño de un negocio, escribe como máximo "
    f"{MAX_LESSONS} lecciones generales sobre marketing o ventas que podrían servir a otro negocio "
    "de la misma industria. "
    "Reglas: no incluyas nombres de personas, del negocio, de productos ni de lugares; no incluyas cifras, precios, "
    "porcentajes, fechas ni enlaces; no copies frases literales; cada lección entre 20 y 300 caracteres. "
    "provenance = owner_decided si es una decisión del dueño, owner_said si es algo que afirmó. "
    "Si no hay nada general que aprender, devuelve una lista vacía."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "lessons": {
            "type": "array",
            "maxItems": MAX_LESSONS,
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "provenance": {"type": "string", "enum": ["owner_said", "owner_decided"]},
                },
                "required": ["text", "provenance"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["lessons"],
    "additionalProperties": False,
}

Complete = Callable[[str, str], Awaitable[str]]


def leaks(text: str, banned: Sequence[str]) -> bool:
    lowered = text.casefold()
    return bool(
        EMAIL.search(text)
        or DIGITS.search(text)
        or URL.search(text)
        or any(name and name.casefold() in lowered for name in banned)
    )


def owner_messages(ledger: Ledger, after: str) -> tuple[dict[str, list[str]], str]:
    with closing(ledger.connect()) as db:
        rows = db.execute(
            "SELECT business_id, payload_json, recorded_at FROM events WHERE kind='owner_message' AND recorded_at > ? "
            "ORDER BY recorded_at LIMIT 400",
            (after,),
        ).fetchall()
    grouped: dict[str, list[str]] = {}
    last = after
    for row in rows:
        text = str(json.loads(row["payload_json"]).get("text") or "")
        if text:
            grouped.setdefault(row["business_id"], []).append(text)
        last = max(last, str(row["recorded_at"]))
    return grouped, last


async def extract_lessons(
    *, ledger: Ledger, complete: Complete | None, banned_names: dict[str, list[str]]
) -> dict[str, Any]:
    after = ledger.checkpoint(CHECKPOINT) or ""
    grouped, last = owner_messages(ledger, after)
    stored = discarded = 0
    if complete is None:
        return {"stored": 0, "discarded": 0}
    for business_id, lines in grouped.items():
        raw = await complete(PROMPT, "\n".join(f"- {line[:500]}" for line in lines[-40:]))
        try:
            lessons = json.loads(raw).get("lessons", [])
        except (ValueError, AttributeError):
            lessons = []
        for item in lessons[:MAX_LESSONS]:
            text = str(item.get("text") or "").strip() if isinstance(item, dict) else ""
            provenance = item.get("provenance") if isinstance(item, dict) else None
            if (
                not (20 <= len(text) <= 300)
                or provenance not in ("owner_said", "owner_decided")
                or leaks(text, banned_names.get(business_id, []))
            ):
                discarded += 1
                continue
            if ledger.add_lesson(business_id=business_id, text=text, provenance=str(provenance)):
                stored += 1
    if last != after:
        ledger.set_checkpoint(CHECKPOINT, last)
    return {"stored": stored, "discarded": discarded}
