import json
import sqlite3

import pytest
from fixtures_seed import BUSINESS
from starlette.testclient import TestClient

from saleads_brain.app import Brain
from saleads_brain.graph import InMemoryStore
from saleads_brain.ledger import Ledger
from saleads_brain.loop import MAX_NAME, LoopError, LoopWriter, window_delta
from saleads_brain.server import ALE_HEADER, create_server
from saleads_brain.settings import group_id, load

GROUP = group_id(BUSINESS)


@pytest.fixture
def writer(tmp_path) -> LoopWriter:
    return LoopWriter(InMemoryStore(), Ledger(tmp_path / "l.db"))


def bet(writer: LoopWriter, statement="Mamás que no tienen tiempo: kit en 5 minutos", adsets=("111",), round=1):
    return writer.record_bet(
        business_id=BUSINESS, statement=statement, avatar="Mamá de 35 sin tiempo", angle="Rutina de 5 minutos",
        format="Video UGC de transformación", adset_ids=list(adsets), round=round, as_of="2026-10-27T10:00:00Z",
    )


def test_bet_connects_avatar_angle_format_and_boxes(writer) -> None:
    out = bet(writer)
    edges = {(e.name, writer.store.node(GROUP, e.target).type_name) for e in writer.store.edges_of(GROUP, out["bet_uuid"])}
    assert {("TARGETS", "Avatar"), ("USES", "Angle"), ("USES", "Format"), ("TESTED_IN", "AdSet")} <= edges
    again = bet(writer, statement="Otra apuesta para la misma mamá", adsets=("222",))
    avatars = [n for n in writer.store.nodes(GROUP, 100) if n.type_name == "Avatar"]
    assert len(avatars) == 1 and again["bet_uuid"] != out["bet_uuid"]


def test_writes_without_anchor_are_rejected_with_a_clear_reason(writer) -> None:
    with pytest.raises(LoopError, match="falta:Avatar"):
        writer.record_bet(business_id=BUSINESS, statement="x", avatar="", angle="a", format="f")
    with pytest.raises(LoopError, match="ancla_inexistente:AdSet"):
        writer.record_result(business_id=BUSINESS, adset_id="999", spend=10)
    writer.store.upsert_node(GROUP, writer._adset(GROUP, "333", "2026-10-27T00:00:00+00:00"))
    with pytest.raises(LoopError, match="caja_sin_apuesta"):
        writer.record_result(business_id=BUSINESS, adset_id="333", spend=10)
    with pytest.raises(LoopError, match="ancla_inexistente: usa el uuid de un veredicto"):
        writer.record_learning(business_id=BUSINESS, statement="x", anchor_uuid="nope", confidence="media", evidence="e")
    with pytest.raises(LoopError, match="falta_scope"):
        writer.record_decision(business_id=BUSINESS, text="No uses mujeres jóvenes", scope=[])


def test_result_window_is_the_difference_between_readings(writer) -> None:
    bet(writer)
    first = writer.record_result(business_id=BUSINESS, adset_id="111", spend=20000, purchases=1, leads=6, as_of="2026-10-29T10:00:00Z")
    second = writer.record_result(business_id=BUSINESS, adset_id="111", spend=50000, purchases=3, leads=14, as_of="2026-11-01T10:00:00Z")
    assert first["window"] == {"spend": 20000.0, "purchases": 1.0, "leads": 6.0, "cpa": 20000.0}
    assert second["window"] == {"spend": 30000.0, "purchases": 2.0, "leads": 8.0, "cpa": 15000.0}
    with pytest.raises(LoopError, match="lectura_no_posterior"):
        writer.record_result(business_id=BUSINESS, adset_id="111", spend=60000, as_of="2026-10-31T10:00:00Z")
    assert window_delta(None, {"spend": 5}) == {"spend": 5.0, "purchases": 0.0, "leads": 0.0, "cpa": 0.0}


def test_verdict_requires_min_spend_and_says_won_in_this_test(writer) -> None:
    b = bet(writer)
    r1 = writer.record_result(business_id=BUSINESS, adset_id="111", spend=15000, purchases=1, as_of="2026-10-29T10:00:00Z")
    with pytest.raises(LoopError, match="gasto_minimo_no_alcanzado"):
        writer.record_verdict(business_id=BUSINESS, bet_uuid=b["bet_uuid"], outcome="gana", reason="r",
                              result_uuids=[r1["result_uuid"]], min_spend=30000)
    early = writer.record_verdict(business_id=BUSINESS, bet_uuid=b["bet_uuid"], outcome="sin_datos", reason="poco gasto",
                                  result_uuids=[r1["result_uuid"]], min_spend=30000, as_of="2026-10-29T11:00:00Z")
    assert early["text"] == "sin datos suficientes"
    r2 = writer.record_result(business_id=BUSINESS, adset_id="111", spend=60000, purchases=4, as_of="2026-11-02T10:00:00Z")
    won = writer.record_verdict(business_id=BUSINESS, bet_uuid=b["bet_uuid"], outcome="gana", reason="CPA bajo y leads buenos",
                                result_uuids=[r2["result_uuid"]], min_spend=30000, lead_quality="buena", as_of="2026-11-02T11:00:00Z")
    assert won["text"] == "ganó en esta prueba" and won["window_spend"] == 45000.0
    assert writer.store.node(GROUP, b["bet_uuid"]).attributes["stage"] == "ganadora"
    other = bet(writer, statement="Apuesta sin relación", adsets=("444",))
    with pytest.raises(LoopError, match="resultado_de_otra_apuesta"):
        writer.record_verdict(business_id=BUSINESS, bet_uuid=other["bet_uuid"], outcome="pierde", reason="r",
                              result_uuids=[r2["result_uuid"]], min_spend=1)


def won_verdict(writer: LoopWriter) -> str:
    b = bet(writer)
    r = writer.record_result(business_id=BUSINESS, adset_id="111", spend=60000, purchases=4, as_of="2026-11-02T10:00:00Z")
    return writer.record_verdict(business_id=BUSINESS, bet_uuid=b["bet_uuid"], outcome="gana", reason="r",
                                 result_uuids=[r["result_uuid"]], min_spend=30000, as_of="2026-11-02T11:00:00Z")["verdict_uuid"]


def test_repeated_learning_adds_evidence_and_contradicted_is_replaced_not_deleted(writer) -> None:
    verdict = won_verdict(writer)
    first = writer.record_learning(business_id=BUSINESS, statement="El ángulo de rutina corta vende a mamás",
                                   anchor_uuid=verdict, confidence="media", evidence="caja 111: CPA 15.000", as_of="2026-11-02T12:00:00Z")
    again = writer.record_learning(business_id=BUSINESS, statement="El  ángulo de rutina corta vende a MAMÁS",
                                   anchor_uuid=verdict, confidence="media", evidence="caja 222: CPA 14.000")
    assert again["reinforced"] and again["evidence_count"] == 2 and again["learning_uuid"] == first["learning_uuid"]
    assert writer.store.node(GROUP, first["learning_uuid"]).attributes["evidence_count"] == 2
    new = writer.record_learning(business_id=BUSINESS, statement="La rutina corta funciona solo con video, no con imagen",
                                 anchor_uuid=verdict, confidence="alta", evidence="caja 555 imagen perdió",
                                 replaces_uuid=first["learning_uuid"], as_of="2026-11-09T12:00:00Z")
    old = writer.store.node(GROUP, first["learning_uuid"])
    assert old is not None and old.attributes["stage"] == "reemplazado" and old.verification == "CONTRADICTED"
    assert any(e.name == "SUPERSEDES" and e.target == old.uuid for e in writer.store.edges_of(GROUP, new["learning_uuid"]))
    assert any(e.name == "TEACHES" and e.target == new["learning_uuid"] for e in writer.store.edges_of(GROUP, verdict))


def test_names_are_short_and_generated_by_code(writer) -> None:
    long = "Una apuesta larguísima " * 20
    out = writer.record_bet(business_id=BUSINESS, statement=long, avatar="a " * 80, angle="b " * 80, format="c " * 80)
    decision = writer.record_decision(business_id=BUSINESS, text="No muestres mujeres de 20 " * 10, scope=["avatar:mamas"])
    assert all(len(n.name) <= MAX_NAME for n in writer.store.nodes(GROUP, 100))
    assert writer.store.node(GROUP, decision["decision_uuid"]).name.startswith("Decisión del dueño: avatar:mamas")
    assert writer.store.node(GROUP, out["bet_uuid"]).summary.startswith("Una apuesta")


def test_learning_from_a_decision_is_an_inference_not_a_platform_fact_or_owner_decision(writer) -> None:
    decision = writer.record_decision(business_id=BUSINESS, text="Use evidence before making promises.", scope=["negocio"])
    learning = writer.record_learning(
        business_id=BUSINESS, statement="Research should verify the promise before drafting.",
        anchor_uuid=decision["decision_uuid"], confidence="media", evidence="owner-message:1",
    )
    node = writer.store.node(GROUP, learning["learning_uuid"])
    assert node.provenance == "inferred"
    assert all(edge.provenance == "inferred" for edge in writer.store.edges_of(GROUP, node.uuid))


def test_ledger_v1_migrates_to_v2_without_losing_rows(tmp_path) -> None:
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
        "INSERT INTO schema_migrations VALUES (1, '2026-10-27');"
        "CREATE TABLE knowledge_revisions (revision_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, canonical_id TEXT NOT NULL,"
        " statement TEXT NOT NULL, provenance TEXT NOT NULL, verification TEXT NOT NULL, evidence_refs_json TEXT NOT NULL,"
        " valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, superseded_at TEXT, version INTEGER NOT NULL,"
        " supersedes_ref TEXT, UNIQUE(canonical_id, version));"
        "INSERT INTO knowledge_revisions VALUES ('r1','b','k1','viejo','owner_said','OBSERVED','[\"e\"]',NULL,NULL,'2026-10-27',NULL,1,NULL);"
    )
    db.commit()
    db.close()
    ledger = Ledger(path)
    Ledger(path)  # idempotente
    assert ledger.schema_versions() == [1, 2, 3, 4, 5, 6]  # Request receipts preserve the existing scoped rows.
    with ledger.transaction() as conn:
        row = conn.execute("SELECT statement, evidence_count, confidence, graph_uuid FROM knowledge_revisions").fetchone()
    assert dict(row) == {"statement": "viejo", "evidence_count": 1, "confidence": None, "graph_uuid": None}


def call(client: TestClient, name: str, args: dict, token: str | None) -> dict:
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if token is not None:
        headers[ALE_HEADER] = token
    response = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                         "params": {"name": name, "arguments": args}})
    for line in response.text.splitlines():
        if line.startswith("data:"):
            body = json.loads(line[5:])
            return json.loads(body["result"]["content"][0]["text"])
    return json.loads(json.loads(response.text)["result"]["content"][0]["text"])


def test_only_ale_writes_learnings_and_feedback(tmp_path) -> None:
    settings = load({"BRAIN_DATA": str(tmp_path / "brain"), "HERMES_DATA": str(tmp_path / "opt"), "BRAIN_PORT": "8765",
                     "BRAIN_ALE_TOKEN": "ale-secret-token"})
    brain = Brain(settings, InMemoryStore(), Ledger(tmp_path / "l.db"))
    writer = LoopWriter(brain.store, brain.ledger)
    verdict = won_verdict(writer)
    app = create_server(brain).streamable_http_app()
    args = {"business_id": BUSINESS, "statement": "Rutina corta vende", "anchor_uuid": verdict, "confidence": "media", "evidence": "e"}
    with TestClient(app, base_url="http://saleads-brain:8765") as client:
        assert call(client, "brain_record_learning", args, None) == {"accepted": False, "reason": "profile_not_allowed"}
        assert call(client, "brain_record_learning", args, "wrong")["reason"] == "profile_not_allowed"
        assert call(client, "brain_record_learning", args, "ale-secret-token")["accepted"] is True
        feedback = {"business_id": BUSINESS, "text": "No uses mujeres de 20", "scope": []}
        assert call(client, "brain_record_feedback", feedback, "ale-secret-token")["reason"].startswith("falta_scope")
        assert call(client, "brain_record_feedback", {**feedback, "scope": ["avatar:mamas"]}, None)["reason"] == "profile_not_allowed"
        bet_args = {"business_id": BUSINESS, "statement": "s", "avatar": "a", "angle": "b", "format": "c"}
        assert call(client, "brain_record_bet", bet_args, None)["accepted"] is True  # los especialistas sí apuestan


def test_concept_name_sin_prefijo_de_tipo() -> None:
    """Con «Avatar: …» la extracción del día no reconoce el nodo y lo duplica (E2E simulado)."""
    from saleads_brain.loop import concept_name

    assert concept_name("Avatar: Mujeres post-parto en Colombia") == "Mujeres post-parto en Colombia"
    assert concept_name("ángulo:  Autoridad   contada por tercero") == "Autoridad contada por tercero"
    assert len(concept_name("x" * 200)) == 80


def test_learning_anchored_to_a_bet_uses_its_latest_verdict_and_bad_anchor_lists_verdicts(writer) -> None:
    """Ale no recuerda el uuid del veredicto (E2E simulado): con la apuesta basta; con un ancla inventada,
    el error le muestra los veredictos para reintentar."""
    verdict = won_verdict(writer)
    bet_uuid = next(e.target for e in writer.store.edges_of(GROUP, verdict) if e.name == "ABOUT")
    out = writer.record_learning(business_id=BUSINESS, statement="Mamás compran con rutina corta",
                                 anchor_uuid=bet_uuid, confidence="media", evidence="caja 111")
    assert out["accepted"]
    assert any(e.name == "TEACHES" and e.target == out["learning_uuid"] for e in writer.store.edges_of(GROUP, verdict))
    with pytest.raises(LoopError, match=verdict):
        writer.record_learning(business_id=BUSINESS, statement="x", anchor_uuid="campaign_results_2026_11_10",
                               confidence="media", evidence="e")


def test_a_no_data_verdict_does_not_become_a_learning(writer) -> None:
    """Corrida completa 1 (Laura): un «sin datos» a minutos de encender quedó como aprendizaje falso."""
    b = bet(writer)
    r = writer.record_result(business_id=BUSINESS, adset_id="111", spend=500, as_of="2026-10-29T10:00:00Z")
    early = writer.record_verdict(business_id=BUSINESS, bet_uuid=b["bet_uuid"], outcome="sin_datos", reason="recién encendida",
                                  result_uuids=[r["result_uuid"]], min_spend=30000, as_of="2026-10-29T11:00:00Z")
    with pytest.raises(LoopError, match="aprendizaje_sin_datos"):
        writer.record_learning(business_id=BUSINESS, statement="El método de pago frena la entrega",
                               anchor_uuid=early["verdict_uuid"], confidence="alta", evidence="0 impresiones")
    with pytest.raises(LoopError, match="aprendizaje_sin_datos"):
        writer.record_learning(business_id=BUSINESS, statement="El método de pago frena la entrega",
                               anchor_uuid=b["bet_uuid"], confidence="alta", evidence="0 impresiones")


def test_an_unknown_business_is_rejected_but_known_ones_and_existing_groups_pass(tmp_path) -> None:
    """Corrida completa 1 (Hernán): un dígito cambiado en el id creaba un negocio vacío en silencio."""
    typo = BUSINESS[:-1] + ("0" if BUSINESS[-1] != "0" else "1")
    writer = LoopWriter(InMemoryStore(), Ledger(tmp_path / "l.db"), known_businesses=lambda: {BUSINESS.lower()})
    assert bet(writer)["bet_uuid"]
    with pytest.raises(LoopError, match="negocio_desconocido"):
        writer.record_bet(business_id=typo, statement="s", avatar="a", angle="b", format="f", as_of="2026-10-27T10:00:00Z")
    # Sin semilla (lista vacía) no se valida: el cerebro sigue funcionando como antes.
    free = LoopWriter(InMemoryStore(), Ledger(tmp_path / "m.db"), known_businesses=lambda: set())
    assert free.record_bet(business_id=typo, statement="s", avatar="a", angle="b", format="f", as_of="2026-10-27T10:00:00Z")


# ------------------------------------------------- MCB-008: un solo hilo por apuesta entre el cerebro y SaleADS

SALEADS_BET = "3f1c2b7e-9a41-4d0e-8b6a-1c2d3e4f5a6b"


def test_link_bet_survives_a_new_record_bet_and_brain_query_returns_it(tmp_path) -> None:
    """Regla (C-16): el bet_uuid del cerebro y el bet_id de SaleADS quedan unidos y no se pierden al re-registrar."""
    settings = load({"BRAIN_DATA": str(tmp_path / "brain"), "HERMES_DATA": str(tmp_path / "opt"), "BRAIN_PORT": "8765"})
    brain = Brain(settings, InMemoryStore(), Ledger(tmp_path / "l.db"))
    app = create_server(brain).streamable_http_app()
    bet_args = {"business_id": BUSINESS, "statement": "Mamás sin tiempo: rutina de 5 minutos", "avatar": "Mamá de 35",
                "angle": "Rutina corta", "format": "Video UGC", "adset_ids": ["111"]}
    with TestClient(app, base_url="http://saleads-brain:8765") as client:
        bet_uuid = call(client, "brain_record_bet", bet_args, None)["bet_uuid"]
        linked = call(client, "brain_link_bet", {"business_id": BUSINESS, "bet_uuid": bet_uuid,
                                                 "saleads_bet_id": SALEADS_BET.upper()}, None)
        again = call(client, "brain_record_bet", bet_args, None)
        found = call(client, "brain_query", {"business_id": BUSINESS, "query": "rutina minutos"}, None)
    assert linked == {"accepted": True, "bet_uuid": bet_uuid, "saleads_bet_id": SALEADS_BET}
    assert again["bet_uuid"] == bet_uuid
    assert brain.store.node(GROUP, bet_uuid).attributes["saleads_bet_id"] == SALEADS_BET
    fact = next(f for f in found["facts"] if f["uuid"] == bet_uuid)
    assert fact["type"] == "Bet" and fact["saleads_bet_id"] == SALEADS_BET


def test_link_bet_rejects_unknown_bets_and_never_overwrites_another_id(writer) -> None:
    """Regla: la integridad del linaje se muestra; una apuesta ya unida no se pisa en silencio."""
    b = bet(writer)
    with pytest.raises(LoopError, match="apuesta_desconocida"):
        writer.link_bet(business_id=BUSINESS, bet_uuid="00000000-0000-4000-8000-0000000000ff", saleads_bet_id=SALEADS_BET)
    with pytest.raises(LoopError, match="saleads_bet_id_invalido"):
        writer.link_bet(business_id=BUSINESS, bet_uuid=b["bet_uuid"], saleads_bet_id="bet-del-cerebro")
    writer.link_bet(business_id=BUSINESS, bet_uuid=b["bet_uuid"], saleads_bet_id=SALEADS_BET)
    assert writer.link_bet(business_id=BUSINESS, bet_uuid=b["bet_uuid"], saleads_bet_id=SALEADS_BET)["accepted"]
    with pytest.raises(LoopError, match="apuesta_ya_unida"):
        writer.link_bet(business_id=BUSINESS, bet_uuid=b["bet_uuid"], saleads_bet_id="9e1c2b7e-9a41-4d0e-8b6a-1c2d3e4f5a6b")
    adset = next(e.target for e in writer.store.edges_of(GROUP, b["bet_uuid"]) if e.name == "TESTED_IN")
    with pytest.raises(LoopError, match="apuesta_desconocida"):
        writer.link_bet(business_id=BUSINESS, bet_uuid=adset, saleads_bet_id=SALEADS_BET)


def test_unknown_business_check_lists_graphs_and_never_reads_the_rejected_one(tmp_path) -> None:
    """Regla (F6): validar el negocio no crea su grafo (antes `_group` consultaba `nodes()` del grupo ajeno)."""

    class Counting(InMemoryStore):
        reads: list[str] = []

        def nodes(self, group, limit):
            self.reads.append(group)
            return super().nodes(group, limit)

        def node(self, group, uuid):
            self.reads.append(group)
            return super().node(group, uuid)

    store = Counting()
    writer = LoopWriter(store, Ledger(tmp_path / "l.db"), known_businesses=lambda: {BUSINESS.lower()})
    bet(writer)
    typo = BUSINESS[:-1] + ("0" if BUSINESS[-1] != "0" else "1")
    before, store.reads[:] = store.groups(), []
    for _ in range(2):
        with pytest.raises(LoopError, match="negocio_desconocido"):
            writer.record_bet(business_id=typo, statement="s", avatar="a", angle="b", format="f")
    assert store.groups() == before and group_id(typo) not in store.reads
