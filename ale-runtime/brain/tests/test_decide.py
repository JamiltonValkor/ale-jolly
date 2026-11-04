import asyncio
import time

import pytest

from saleads_brain import decide as decide_mod
from saleads_brain.decide import decide, route
from saleads_brain.ledger import Ledger

BUSINESS = "ec81555c-3d02-5d2f-a2bb-bc23b9c441aa"


def calls(ledger: Ledger) -> tuple[int, float]:
    with ledger.transaction() as db:
        row = db.execute("SELECT COALESCE(SUM(calls),0) c, COALESCE(SUM(cost_usd),0) u FROM usage_daily WHERE business_id=?",
                         (BUSINESS,)).fetchone()
    return int(row["c"]), float(row["u"])


def answers(**p: float) -> dict:
    return {"answers": {k: {"noul": v} for k, v in p.items()}, "usage": {"input_tokens": 500, "output_tokens": 100, "cost": 2e-05}}


def test_without_openrouter_key_returns_no_signal_without_network(tmp_path, monkeypatch) -> None:
    async def boom(*_a, **_k):
        raise AssertionError("no network")

    monkeypatch.setattr(decide_mod, "_post", boom)
    ledger = Ledger(tmp_path / "l.db")
    out = asyncio.run(decide(api_key=None, ledger=ledger, business_id=BUSINESS, kind="reparto", situation="hola"))
    assert out == {"senal": "sin_senal", "motivo": "sin_key_openrouter"}
    assert calls(ledger) == (0, 0.0)


def test_endpoint_error_returns_no_signal_fast(tmp_path) -> None:
    async def failing(_body, _key):
        raise RuntimeError("502")

    ledger = Ledger(tmp_path / "l.db")
    t0 = time.monotonic()
    out = asyncio.run(decide(api_key="k", ledger=ledger, business_id=BUSINESS, kind="hablar", situation="x", post=failing))
    assert out["senal"] == "sin_senal" and time.monotonic() - t0 < 5
    assert decide_mod.TIMEOUT_S < 5
    assert calls(ledger) == (0, 0.0)


def test_malformed_answer_is_no_signal(tmp_path) -> None:
    async def weird(_body, _key):
        return {"answers": {"market": {"noul": 0.9}}}

    out = asyncio.run(decide(api_key="k", ledger=Ledger(tmp_path / "l.db"), business_id=BUSINESS, kind="reparto",
                             situation="x", post=weird))
    assert out["senal"] == "sin_senal"


def test_successful_routing_counts_one_call_and_suggests_specialist(tmp_path) -> None:
    sent: list[dict] = []

    async def jev(body, key):
        sent.append(body)
        assert key == "k"
        return answers(market=0.96, own_results=0.09, strategy=0.12, structure=0.05, optimize=0.05, chitchat=0.02)

    ledger = Ledger(tmp_path / "l.db")
    out = asyncio.run(decide(api_key="k", ledger=ledger, business_id=BUSINESS, kind="reparto",
                             situation="¿qué hacen los competidores?", post=jev))
    assert out["senal"] == "ok" and out["sugerencia"] == "investigador" and out["ambigua"] is False
    assert out["costo_estimado"] is False
    assert sent[0]["model"] == "~typesafe/jev-latest" and set(sent[0]["questions"]) == {
        "market", "own_results", "strategy", "structure", "optimize", "chitchat"}
    assert calls(ledger) == (1, pytest.approx(2e-05))


def test_missing_cost_still_counts_the_call_as_estimated(tmp_path) -> None:
    async def jev(_body, _key):
        return {"answers": {"vale_la_pena_hablar": {"noul": 0.2}}}

    ledger = Ledger(tmp_path / "l.db")
    out = asyncio.run(decide(api_key="k", ledger=ledger, business_id=BUSINESS, kind="hablar", situation="x", post=jev))
    assert out == {"senal": "ok", "probabilidades": {"vale_la_pena_hablar": 0.2}, "costo_estimado": True}
    assert calls(ledger) == (1, 0.0)


@pytest.mark.parametrize(
    ("p", "expected"),
    [
        ({"market": 0.07, "own_results": 0.1, "strategy": 0.04, "structure": 0.04, "optimize": 0.04, "chitchat": 0.97},
         {"sugerencia": None, "ambigua": False}),
        ({"market": 0.11, "own_results": 0.13, "strategy": 0.11, "structure": 0.08, "optimize": 0.08, "chitchat": 0.59},
         {"sugerencia": None, "ambigua": False}),
        ({"market": 0.3, "own_results": 0.2, "strategy": 0.1, "structure": 0.1, "optimize": 0.91, "chitchat": 0.02},
         {"sugerencia": "optimizador", "ambigua": False}),
        ({"market": 0.52, "own_results": 0.51, "strategy": 0.2, "structure": 0.1, "optimize": 0.1, "chitchat": 0.04},
         {"sugerencia": "investigador", "ambigua": True, "alternativa": "analista"}),
    ],
)
def test_route(p, expected) -> None:
    assert route(p) == expected


def test_unknown_kind_is_no_signal(tmp_path) -> None:
    out = asyncio.run(decide(api_key="k", ledger=Ledger(tmp_path / "l.db"), business_id=BUSINESS, kind="otro", situation="x"))
    assert out["motivo"] == "tipo_desconocido"


def test_brain_decide_is_off_without_any_network_call(tmp_path, monkeypatch) -> None:
    """Regla (MCB-009, D16): Jev apagado limpio; Ale decide con su juicio y nada sale a la red."""
    import json

    import httpx2
    from starlette.testclient import TestClient

    from saleads_brain.app import Brain
    from saleads_brain.graph import InMemoryStore
    from saleads_brain.server import create_server
    from saleads_brain.settings import load

    async def no_network(*_a, **_k):
        raise AssertionError("llamada de red")

    monkeypatch.setattr(httpx2.AsyncClient, "send", no_network)
    monkeypatch.setattr(decide_mod, "_post", no_network)
    settings = load({"OPENROUTER_API_KEY": "sk-or-v1-x", "BRAIN_DATA": str(tmp_path / "b"), "HERMES_DATA": str(tmp_path / "o"),
                     "BRAIN_PORT": "8765"})
    ledger = Ledger(tmp_path / "l.db")
    app = create_server(Brain(settings, InMemoryStore(), ledger)).streamable_http_app()
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    with TestClient(app, base_url="http://saleads-brain:8765") as client:
        tools = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).text
        assert "Disabled compatibility tool." in tools  # sigue registrada: un bundle 1.5.9 no recibe «tool desconocida»
        response = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "brain_decide", "arguments": {"business_id": BUSINESS, "kind": "reparto", "situation": "¿qué hago?"}}})
    line = next(x for x in response.text.splitlines() if x.startswith("data:"))
    assert json.loads(json.loads(line[5:])["result"]["content"][0]["text"]) == {"senal": "sin_senal", "motivo": "jev_apagado"}
    assert calls(ledger) == (0, 0.0)
