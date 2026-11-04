import asyncio
import gzip
import json

import pytest
from fixtures_seed import BUSINESS, SEED
from starlette.testclient import TestClient
from test_quotes import state_db

from saleads_brain import search as words
from saleads_brain.app import Brain
from saleads_brain.graph import InMemoryStore
from saleads_brain.ledger import Ledger
from saleads_brain.loop import LoopWriter, owner_note_uuid
from saleads_brain.server import create_server
from saleads_brain.settings import group_id, load


def brain(tmp_path):
    (tmp_path / "opt" / "saleads" / "seed").mkdir(parents=True)
    (tmp_path / "opt" / "saleads" / "seed" / "seed.json").write_text(json.dumps(SEED))
    settings = load(
        {
            "BRAIN_DATA": str(tmp_path / "brain"),
            "HERMES_DATA": str(tmp_path / "opt"),
            "BRAIN_PORT": "8765",
        }
    )
    return Brain(settings, InMemoryStore(), Ledger(tmp_path / "l.db"))


def test_run_routes_are_silent_and_work_without_ai(tmp_path) -> None:
    b = brain(tmp_path)
    app = create_server(b).streamable_http_app()
    with TestClient(app, base_url="http://saleads-brain:8765") as client:
        assert client.get("/health").json() == {"status": "ok"}
        seeded = client.post("/run/ingest-seed").json()
        assert seeded["ok"] and seeded["message"] == "" and seeded["nodes"] >= 8
        snap = client.post("/run/export-snapshot").json()
        assert snap["ok"] and snap["businesses"] == 1
        assert (tmp_path / "opt" / "saleads" / "graph" / "snapshot.json.gz").exists()
        assert client.post("/run/ingest-day").json()["message"] == ""
        assert client.post("/run/nope").status_code == 404


def test_foreign_host_header_is_refused(tmp_path) -> None:
    app = create_server(brain(tmp_path)).streamable_http_app()
    with TestClient(app, base_url="http://evil.example") as client:
        response = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={"Accept": "application/json, text/event-stream"},
        )
        assert response.status_code in (400, 421)


def test_value_report_and_loops(tmp_path) -> None:
    b = brain(tmp_path)
    loop = b.ledger.open_loop(business_id=BUSINESS, title="Anuncio rechazado", kind="account_health")
    assert b.ledger.close_loop(loop, "Releído en Meta: aprobado")
    b.ledger.set_noise("2026-11-11", 6, 2)
    report = b.ledger.value_report(BUSINESS, "2026-10-27")
    assert report["loops_closed"] == 1 and report["noise_ratio"] == 3.0


# ---------------------------------------------------------------- MCB-009: el cerebro guarda y encuentra

GROUP = group_id(BUSINESS)
TYPO = BUSINESS[:-1] + ("0" if BUSINESS[-1] != "0" else "1")


def call(client: TestClient, name: str, args: dict, token: str | None = None) -> dict:
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if token is not None:
        headers["x-saleads-brain-token"] = token
    response = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                         "params": {"name": name, "arguments": args}})
    for line in response.text.splitlines():
        if line.startswith("data:"):
            return json.loads(json.loads(line[5:])["result"]["content"][0]["text"])
    return json.loads(json.loads(response.text)["result"]["content"][0]["text"])


def client_for(b: Brain) -> TestClient:
    return TestClient(create_server(b, export_delay=60).streamable_http_app(), base_url="http://saleads-brain:8765")


def seeded(tmp_path, token: str | None = None) -> Brain:
    b = brain(tmp_path)
    if token:
        b = Brain(load({"BRAIN_DATA": str(tmp_path / "brain"), "HERMES_DATA": str(tmp_path / "opt"),
                        "BRAIN_PORT": "8765", "BRAIN_ALE_TOKEN": token}), b.store, b.ledger)
    asyncio.run(b.run("ingest-seed"))
    return b


def test_query_finds_what_was_stored_with_other_wording(tmp_path) -> None:
    """Regla (MCN-007): lo que Ale guardó en una vuelta se encuentra en la siguiente aunque pregunte distinto."""
    b = seeded(tmp_path)
    assert not [n for n in b.store.nodes(GROUP, 500) if "presupuesto" in words.fold(n.summary)]
    writer = LoopWriter(b.store, b.ledger, quote_checker=lambda _q: "ok")
    decision = writer.record_decision(business_id=BUSINESS, text="Hernán reparte el presupuesto por mitades",
                                      scope=["negocio"], owner_quote="Hernán reparte el presupuesto por mitades")
    with client_for(b) as client:
        for query in ("presupuesto", "¿qué presupuesto aprobó?", "aprobo presupuesto"):
            out = call(client, "brain_query", {"business_id": BUSINESS, "query": query})
            assert out["modo"] == "palabras" and out["facts"][0]["uuid"] == decision["decision_uuid"], query
            fact = out["facts"][0]
            assert fact["type"] == "Decision" and fact["provenance"] == "owner_decided" and fact["created_at"]
        empty = call(client, "brain_query", {"business_id": BUSINESS, "query": "tiktok"})
        assert empty == {"facts": [], "modo": "palabras", "vacio_por": "sin_coincidencias"}


def test_owner_margin_is_remembered_in_another_session_without_asking_again(tmp_path) -> None:
    """Regla (MCN-008): Ale aprende del dueño desde el primer día; lo repetido refuerza, no duplica."""
    b = seeded(tmp_path)
    args = {"business_id": BUSINESS, "text": "Mi margen es 35 % en los paquetes de novia"}
    with client_for(b) as client:
        first = call(client, "brain_ingest", args)
        again = call(client, "brain_ingest", {**args, "text": "mi margen es 35 %  en los paquetes de NOVIA"})
    assert first["accepted"] and first["type"] == "OwnerNote" and first["degradado"] is None
    assert again["node_uuid"] == first["node_uuid"] and again["evidence_count"] == 2
    with client_for(b) as other_session:
        out = call(other_session, "brain_query", {"business_id": BUSINESS, "query": "margen"})
    fact = out["facts"][0]
    assert fact["type"] == "OwnerNote" and fact["provenance"] == "owner_said" and "35 %" in fact["fact"]
    assert fact["scope"] == "negocio" and fact["evidence_count"] == 2


def test_owner_decided_without_quote_is_kept_degraded_and_with_quote_is_validated(tmp_path) -> None:
    """Regla (D2): los datos son argumentos, no bloqueos; solo con la cita del dueño hay decisión validada."""
    b = seeded(tmp_path)
    state_db(tmp_path / "opt" / "state.db", [
        ("s1", "assistant", "¿Cuánto quiere invertir este mes?"),
        ("s1", "user", "Para este mes dejemos 800 mil, no más"),
    ])
    with client_for(b) as client:
        bare = call(client, "brain_ingest", {"business_id": BUSINESS, "text": "Tope de 800 mil al mes",
                                              "provenance": "owner_decided"})
        missing = call(client, "brain_ingest", {"business_id": BUSINESS, "text": "Tope de 900 mil al mes",
                                                 "provenance": "owner_decided", "owner_quote": "dejemos 900 mil"})
        quoted = call(client, "brain_ingest", {"business_id": BUSINESS, "text": "Tope de 800 mil al mes",
                                                "provenance": "owner_decided", "owner_quote": "dejemos 800 mil, no más"})
    assert bare["accepted"] and bare["provenance"] == "owner_said" and bare["degradado"] == "sin_cita"
    assert missing["provenance"] == "owner_said" and missing["degradado"] == "cita_no_encontrada"
    assert quoted["type"] == "Decision" and quoted["degradado"] is None
    node = b.store.node(GROUP, quoted["node_uuid"])
    assert node.provenance == "owner_decided" and node.verification == "HUMAN_VALIDATED"
    assert node.summary == "dejemos 800 mil, no más" and node.attributes["owner_quote"] == "dejemos 800 mil, no más"
    assert node.attributes["interpretation"] == "Tope de 800 mil al mes"


def test_echo_of_ale_never_becomes_an_owner_decision(tmp_path) -> None:
    """Regla (MCN-008, F3): el eco de Ale repetido por el dueño baja a inferido y no es «tus correcciones»."""
    b = seeded(tmp_path)
    state_db(tmp_path / "opt" / "state.db", [
        ("s1", "assistant", "No activé nada"),
        ("s1", "user", "No active nada todavía, ¿listo?"),
    ])
    with client_for(b) as client:
        out = call(client, "brain_ingest", {"business_id": BUSINESS, "text": "El dueño no quiere activar nada todavía",
                                            "provenance": "owner_decided", "owner_quote": "No active nada todavía, ¿listo?"})
        assert client.post("/run/export-snapshot").json()["ok"]
    assert out["accepted"] and out["provenance"] == "inferred" and out["degradado"] == "eco_de_ale"
    assert b.store.node(GROUP, out["node_uuid"]).verification == "INFERRED"
    snap = json.loads(gzip.decompress((tmp_path / "opt" / "saleads" / "graph" / "snapshot.json.gz").read_bytes()))
    sections = snap["businesses"][0]["sections"]
    assert out["node_uuid"] not in sections["your_corrections"] and out["node_uuid"] in sections["to_confirm"]


def test_feedback_keeps_the_owner_words_and_ale_reading_apart(tmp_path) -> None:
    """Regla (sol/hernan): «no ponga anuncios todavía» no se amplía a «ni siquiera en pausa»: manda la cita."""
    b = seeded(tmp_path, token="ale")
    state_db(tmp_path / "opt" / "state.db", [
        ("s1", "assistant", "Tengo listas tres campañas. ¿Las dejo preparadas?"),
        ("s1", "user", "Hágale usted que sabe, pero no ponga anuncios todavía"),
    ])
    with client_for(b) as client:
        out = call(client, "brain_record_feedback", {"business_id": BUSINESS, "text": "No publicar ni siquiera en pausa",
                                                     "scope": ["negocio"], "owner_quote": "no ponga anuncios todavía"}, "ale")
        bare = call(client, "brain_record_feedback", {"business_id": BUSINESS, "text": "Prefiere fotos de producto",
                                                      "scope": ["formato"]}, "ale")
    node = b.store.node(GROUP, out["decision_uuid"])
    assert node.summary == "no ponga anuncios todavía" and node.attributes["interpretation"] == "No publicar ni siquiera en pausa"
    assert node.provenance == "owner_decided" and node.verification == "HUMAN_VALIDATED"
    unquoted = b.store.node(GROUP, bare["decision_uuid"])
    assert bare["degradado"] == "sin_cita" and unquoted.verification == "INFERRED" and unquoted.provenance == "inferred"


def test_openrouter_key_in_the_environment_has_no_effect(tmp_path, monkeypatch) -> None:
    """Regla (D16): nunca OpenRouter. El watcher copia el .env del dueño; el cerebro ignora la key."""
    import openai

    from saleads_brain import graph

    def boom(*_a, **_k):
        raise AssertionError("cliente de OpenRouter construido")

    monkeypatch.setattr(graph, "graphiti_for", boom)
    monkeypatch.setattr(openai, "AsyncOpenAI", boom)
    (tmp_path / "opt" / "saleads" / "seed").mkdir(parents=True)
    (tmp_path / "opt" / "saleads" / "seed" / "seed.json").write_text(json.dumps(SEED))
    settings = load({"OPENROUTER_API_KEY": "sk-or-v1-real", "BRAIN_DATA": str(tmp_path / "brain"),
                     "HERMES_DATA": str(tmp_path / "opt"), "BRAIN_PORT": "8765"})
    assert settings.llm_enabled is False and settings.api_key is None
    b = Brain(settings, InMemoryStore(), Ledger(tmp_path / "l.db"))
    b.ledger.record_event(business_id=BUSINESS, kind="owner_message", provenance="owner_said", source_uri="hermes://x",
                          occurred_at="2026-11-15T10:00:00Z", payload={"text": "vendo sérum"})
    state_db(tmp_path / "opt" / "state.db", [("s1", "user", "Example Beauty vende sérum")])
    from saleads_brain.app import COMMANDS

    for command in COMMANDS:
        assert asyncio.run(b.run(command))["ok"], command
    with client_for(b) as client:
        assert call(client, "brain_query", {"business_id": BUSINESS, "query": "serum"})["facts"]


@pytest.mark.parametrize("bad", [TYPO, "no-es-un-id", "excel contable pro"])
def test_foreign_or_malformed_business_creates_no_graph(tmp_path, bad) -> None:
    """Regla (F6): un id ajeno o mal formado no crea grafos basura que contaminen la foto y el sync a BI."""
    b = seeded(tmp_path)
    before = b.store.groups()
    with client_for(b) as client:
        query = call(client, "brain_query", {"business_id": bad, "query": "precio"})
        ingest = call(client, "brain_ingest", {"business_id": bad, "text": "Mi margen es 35 %"})
        loops = call(client, "brain_loops_open", {"business_id": bad, "title": "x"})
        report = call(client, "brain_value_report", {"business_id": bad})
    for out in (query, ingest, loops, report):
        assert out["accepted"] is False
        assert out["reason"].startswith("negocio_desconocido" if bad == TYPO else "business_id_invalido")
    assert query["facts"] == [] and b.store.groups() == before


def test_known_business_without_graph_says_so_instead_of_an_empty_answer(tmp_path) -> None:
    b = brain(tmp_path)  # semilla escrita pero sin ingest-seed: el negocio no tiene grafo todavía
    with client_for(b) as client:
        out = call(client, "brain_query", {"business_id": BUSINESS, "query": "precio"})
    assert out == {"facts": [], "modo": "palabras", "vacio_por": "negocio_sin_datos"} and b.store.groups() == []


def test_backfill_turns_old_ingests_into_owner_notes_once_and_never_into_decisions(tmp_path) -> None:
    """Regla (invariante 7): lo que ya está en las VMs de dev se vuelve legible sin inflar la procedencia."""
    b = seeded(tmp_path)
    for business, provenance, text in ((BUSINESS, "owner_decided", "No quiero descuentos este mes"),
                                       (BUSINESS, "owner_said", "Abro los domingos"),
                                       ("excel contable pro", "owner_said", "dato de otro"),
                                       (TYPO, "owner_said", "dato de un id con un dígito cambiado")):
        b.ledger.record_event(business_id=business, kind="owner_message", provenance=provenance,
                              source_uri="mcp://brain_ingest", occurred_at="2026-11-15T10:00:00Z", payload={"text": text})
    groups = b.store.groups()
    first = asyncio.run(b.run("backfill-owner-notes"))["owner_notes"]
    nodes = {n.uuid: (n.provenance, n.summary) for n in b.store.nodes(GROUP, 500) if n.type_name == "OwnerNote"}
    second = asyncio.run(b.run("ingest-day"))["owner_notes"]
    assert first == {"created": 2, "skipped": 0, "rejected": 2} and second == {"created": 0, "skipped": 2, "rejected": 2}
    assert nodes == {n.uuid: (n.provenance, n.summary) for n in b.store.nodes(GROUP, 500) if n.type_name == "OwnerNote"}
    assert {p for p, _ in nodes.values()} == {"owner_said"} and owner_note_uuid(GROUP, "Abro los domingos") in nodes
    assert b.store.groups() == groups
    # Lo que brain_ingest ya escribió en el grafo no se vuelve a convertir.
    with client_for(b) as client:
        call(client, "brain_ingest", {"business_id": BUSINESS, "text": "Atiendo por WhatsApp"})
    assert asyncio.run(b.run("backfill-owner-notes"))["owner_notes"]["created"] == 0
