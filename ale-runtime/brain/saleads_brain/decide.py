"""Señales de Jev para Ale (MLB-007): proposiciones sí/no → probabilidades.

Jev (TypeSafe, `~typesafe/jev-latest`) responde por el endpoint de Decisiones de
OpenRouter. Es una señal, nunca una regla: sin key, con error o con respuesta
rara devuelve `sin_senal` y Ale sigue con su propio juicio. Las proposiciones
del reparto se validaron con escenarios etiquetados
(docs/tasks/saleads-agente-marketing-loop-v1/pruebas/compuerta/jev_routing5.py).
Nunca registra el estado ni el mensaje del dueño.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx2 as httpx

from saleads_brain.ledger import Ledger

DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
JEV_MODEL = "~typesafe/jev-latest"
TIMEOUT_S = 4.0
MAX_STATE_CHARS = 4000

# Una proposición por especialista; el código traduce la más probable.
ROUTING: dict[str, tuple[str, str]] = {
    "market": (
        "investigador",
        "Answering owner_message requires researching the external market: competitors, reference brands, trends, "
        "formats or audiences outside the owner's own campaigns and customers.",
    ),
    "own_results": (
        "analista",
        "Answering owner_message requires reading or judging the owner's own data: how their campaigns and boxes "
        "perform, or who the leads and customers reaching them are and why they do or do not buy. It does not ask to "
        "change, scale, cut, launch or build anything.",
    ),
    "strategy": (
        "estratega",
        "owner_message asks to create new creative bets: avatars, angles, messages or boxes to test next.",
    ),
    "structure": (
        "estructurador",
        "owner_message asks to assemble a new campaign launch: campaign structure (ABO/CBO), ads per box, or initial "
        "learning budget split for a launch.",
    ),
    "optimize": (
        "optimizador",
        "owner_message asks to change a campaign that is already running: scale a winner, add to it, cut spend or "
        "adjust budget after results.",
    ),
}
CHITCHAT = "owner_message is small talk, greetings or thanks with no task to do."
# Dos especialistas a menos de este margen: la señal es ambigua y Ale elige.
AMBIGUOUS_MARGIN = 0.05

SIGNALS: dict[str, str] = {
    "vale_la_pena_hablar": (
        "Sending message_draft to the owner now gives them new, useful information or a decision they need to make, "
        "instead of repeating what they already know or interrupting without a reason."
    ),
    "evidencia_suficiente": (
        "The evidence in state is enough to say which box won in this test: boxes of the same campaign, the same time "
        "window, the minimum spend reached, and lead quality considered."
    ),
}

KINDS = ("reparto", "hablar", "evidencia")

Post = Callable[[dict[str, Any], str], Any]


def _no_signal(reason: str) -> dict[str, Any]:
    return {"senal": "sin_senal", "motivo": reason}


def questions_for(kind: str) -> dict[str, str]:
    if kind == "reparto":
        return {**{key: text for key, (_, text) in ROUTING.items()}, "chitchat": CHITCHAT}
    if kind == "hablar":
        return {"vale_la_pena_hablar": SIGNALS["vale_la_pena_hablar"]}
    return {"evidencia_suficiente": SIGNALS["evidencia_suficiente"]}


def route(probabilities: dict[str, float]) -> dict[str, Any]:
    """Traduce las probabilidades del reparto a una sugerencia (validado 20-21/21)."""
    ranked = sorted(ROUTING, key=lambda key: probabilities.get(key, 0.0), reverse=True)
    best, second = ranked[0], ranked[1]
    top = probabilities.get(best, 0.0)
    if probabilities.get("chitchat", 0.0) >= 0.5 and top < 0.5:
        return {"sugerencia": None, "ambigua": False}
    if top - probabilities.get(second, 0.0) < AMBIGUOUS_MARGIN:
        return {"sugerencia": ROUTING[best][0], "ambigua": True, "alternativa": ROUTING[second][0]}
    return {"sugerencia": ROUTING[best][0], "ambigua": False}


async def _post(body: dict[str, Any], api_key: str) -> Any:
    async with httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_S)) as client:
        response = await client.post(DECISIONS_URL, json=body, headers={"Authorization": f"Bearer {api_key}"})
        response.raise_for_status()
        return response.json()


async def decide(
    *,
    api_key: str | None,
    ledger: Ledger,
    business_id: str,
    kind: str,
    situation: str,
    post: Post | None = None,
) -> dict[str, Any]:
    """`kind`: reparto (owner_message = situation), hablar (message_draft) o evidencia (state)."""
    if kind not in KINDS:
        return _no_signal("tipo_desconocido")
    if not api_key:
        return _no_signal("sin_key_openrouter")
    if not situation.strip():
        return _no_signal("sin_situacion")
    field = {"reparto": "owner_message", "hablar": "message_draft", "evidencia": "state"}[kind]
    questions = questions_for(kind)
    body = {
        "model": JEV_MODEL,
        "state": {field: situation[:MAX_STATE_CHARS]},
        "questions": {key: {"type": "noul", "instructions": text} for key, text in questions.items()},
    }
    try:
        data = await (post or _post)(body, api_key)
        answers = data["answers"]
        probabilities = {key: round(float(answers[key]["noul"]), 3) for key in questions}
    except Exception:  # noqa: BLE001 — una señal nunca bloquea: cualquier fallo es «sin señal»
        return _no_signal("error_jev")
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    cost = usage.get("cost")
    tokens = float(usage.get("input_tokens") or 0) + float(usage.get("output_tokens") or 0)
    ledger.add_usage(datetime.now(UTC).date().isoformat(), business_id, tokens, float(cost or 0), 1)
    result: dict[str, Any] = {"senal": "ok", "probabilidades": probabilities, "costo_estimado": cost is None}
    if kind == "reparto":
        result.update(route(probabilities))
    return result
