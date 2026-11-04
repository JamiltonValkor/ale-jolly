import gzip
import json
from pathlib import Path

import jsonschema
from fixtures_seed import BUSINESS, SEED

from saleads_brain import snapshot
from saleads_brain.graph import InMemoryStore
from saleads_brain.ledger import Ledger
from saleads_brain.seed import SeedLoader
from saleads_brain.settings import group_id

SCHEMA = json.loads(
    (Path(__file__).parent.parent / "contracts" / "saleads-explorer-snapshot-3.schema.json").read_text()
)


def load(tmp_path):
    store = InMemoryStore()
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(SEED))
    counts = SeedLoader(store, Ledger(tmp_path / "l.db")).load_file(path)
    return store, counts


def test_seed_creates_facts_with_saleads_provenance(tmp_path) -> None:
    store, counts = load(tmp_path)
    assert counts["businesses"] == 1 and counts["nodes"] >= 8
    nodes = store.nodes(group_id(BUSINESS), 100)
    types = {n.type_name for n in nodes}
    assert {"Business", "ProductOrService", "Offer", "Segment", "Campaign", "CustomerNeed", "Bet", "Avatar", "Angle"} <= types
    assert not types & {"Hypothesis", "MetricObservation", "Creative"}
    assert all(n.provenance == "saleads_seed" for n in nodes)
    offer = next(n for n in nodes if n.type_name == "Offer")
    assert offer.attributes["price"] == "89000" and offer.name == "Oferta: Sérum facial"


def test_seed_is_idempotent(tmp_path) -> None:
    store, _ = load(tmp_path)
    before = len(store.nodes(group_id(BUSINESS), 500))
    path = tmp_path / "seed.json"
    SeedLoader(store, Ledger(tmp_path / "l.db")).load_file(path)
    assert len(store.nodes(group_id(BUSINESS), 500)) == before


def test_seed_rejects_other_schema(tmp_path) -> None:
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"schema": "other"}))
    try:
        SeedLoader(InMemoryStore(), Ledger(tmp_path / "l.db")).load_file(path)
    except ValueError as error:
        assert "seed_schema_invalid" in str(error)
    else:
        raise AssertionError("must fail")


def test_snapshot_matches_schema_and_has_no_embeddings(tmp_path) -> None:
    store, _ = load(tmp_path)
    data = snapshot.build(store)
    jsonschema.validate(data, SCHEMA)
    assert data["businesses"][0]["business_id"] == BUSINESS
    assert "embedding" not in json.dumps(data)
    families = {n["family"] for n in data["businesses"][0]["nodes"]}
    assert {"identity", "offer", "market", "channels", "strategy"} <= families


def test_snapshot_written_only_when_it_changes(tmp_path) -> None:
    store, _ = load(tmp_path)
    path = tmp_path / "graph" / "snapshot.json.gz"
    snapshot.write(store, path)
    first = path.stat().st_mtime_ns
    snapshot.write(store, path)
    assert path.stat().st_mtime_ns == first
    assert json.loads(gzip.decompress(path.read_bytes()))["schema"] == "saleads-explorer-snapshot/3"


def test_business_id_round_trip() -> None:
    assert snapshot.business_id_of(group_id(BUSINESS)) == BUSINESS
    assert snapshot.business_id_of("default_db") is None


def test_seed_free_text_never_carries_personal_data(tmp_path) -> None:
    """Laboratorio capa 1 (L1-01): un email, teléfono o dirección escritos en texto libre."""
    import copy

    seed = copy.deepcopy(SEED)
    facts = seed["businesses"][0]["context"]["facts"]
    facts["audience"]["description"] = "Novias; escríbenos a dueña@bridal.example, 3001234567 o Calle 85 #11-20"
    seed["businesses"][0]["context"]["buyer_fit"]["pain_points"]["value"].append("llamar a Laura al +57 300 123 4567")
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(seed))
    store = InMemoryStore()
    SeedLoader(store, Ledger(tmp_path / "l.db")).load_file(path)
    blob = json.dumps([[n.name, n.summary, n.attributes] for n in store.nodes(group_id(BUSINESS), 200)], ensure_ascii=False)
    for leaked in ("dueña@bridal.example", "3001234567", "Calle 85 #11-20", "300 123 4567"):
        assert leaked not in blob


def test_seed_nodes_read_like_a_consultant_wrote_them(tmp_path) -> None:
    """Laboratorio capa 1 (L1-13): el precio y las métricas se leen en el resumen del nodo."""
    store, _ = load(tmp_path)
    nodes = store.nodes(group_id(BUSINESS), 100)
    offer = next(n for n in nodes if n.type_name == "Offer")
    assert offer.summary == "89.000 COP"
    bet = next(n for n in nodes if n.type_name == "Bet")
    assert "{" not in bet.summary and bet.summary == "Maquillaje que dura"


def test_redaction_never_cuts_ids() -> None:
    from saleads_brain.privacy import redact

    for value in ("00000000-0000-4000-8000-000000000002", "a1111111-1111-4111-8111-111111111111", "plan-a111", "cmp-300123"):
        assert redact(value) == value
    assert redact("llama al 300-123-4567 hoy") == "llama al [dato personal] hoy"


def test_snapshot_from_conversations_is_valid_and_clean(tmp_path) -> None:
    """Laboratorio capa 1 (L1-12/L1-13/L1-02): lo que Graphiti escribe desde conversaciones."""
    from saleads_brain.graph import Edge, Node

    store, _ = load(tmp_path)
    group = group_id(BUSINESS)
    store.upsert_node(group, Node(uuid="owner", type_name="Person", name="Dueño", summary="habla", provenance=""))
    store.upsert_node(group, Node(uuid="asist", type_name="Entity", name="Asistente", summary="", provenance="inferred"))
    store.upsert_node(group, Node(uuid="pkg", type_name="ProductOrService", name="paquete madre de la novia",
                                  summary="nuevo", provenance="Medellín, Colombia", verification="weird"))
    store.upsert_edge(group, Edge(source="owner", target="pkg", name="OWNER_SAID", fact="lo propuso"))
    long_name = "Burger Rayo no tiene domicilio gratis y ahora cuesta 4000 pesos. (2026-11-03 14:07:30+00:00)"
    seeded = next(n.uuid for n in store.nodes(group, 100) if n.type_name == "Business")
    store.upsert_edge(group, Edge(source=seeded, target="pkg", name=long_name, fact="x" * 400))
    snap = snapshot.build(store, generated_at="")
    jsonschema.validate(snap, SCHEMA)
    business = snap["businesses"][0]
    labels = {n["label"] for n in business["nodes"]}
    assert "Dueño" not in labels and "Asistente" not in labels
    assert all(e["source"] not in ("owner", "asist") for e in business["edges"])
    pkg = next(n for n in business["nodes"] if n["id"] == "pkg")
    assert pkg["provenance"] == "conversation" and pkg["state"] == "observed"
    relation = next(e for e in business["edges"] if e["target"] == "pkg")
    assert len(relation["type"]) <= 64 and relation["type"] == relation["type"].upper()


def test_seed_text_decodes_html_entities() -> None:
    from saleads_brain.seed import _text

    assert _text("Mantequilla para Rizos &#8211; Menta &amp; Kaba") == "Mantequilla para Rizos – Menta & Kaba"


def test_seed_keys_do_not_change_with_display_cleanup(tmp_path) -> None:
    """Un producto sin id conserva su nodo aunque su nombre se muestre decodificado."""
    store = InMemoryStore()
    loader = SeedLoader(store, Ledger(tmp_path / "ledger.db"))
    payload = json.loads(json.dumps(SEED["businesses"][0]))
    payload["context"]["facts"]["products"] = [{"name": "Kit &#8211; Kaba", "price": 1000, "currency": "COP"}]
    loader.load_business(payload)
    from saleads_brain.ledger import stable_id

    group = group_id(payload["business_id"])
    names = {n.uuid: n.name for n in store.nodes(group, 500)}
    assert names[stable_id(group, "ProductOrService", "Kit &#8211; Kaba")] == "Kit – Kaba"


V2_PAYLOAD = {
    **SEED["businesses"][0],
    "schema_version": "saleads-business-bootstrap/2",
    "plan": {
        "plan_id": "pl1", "status": "active",
        "campaigns": [
            {"item_id": "i1", "name": "Novias", "status": "launched", "hypothesis_id": None, "offering_id": "p1",
             "communication_summary": {"tension": "No hay tiempo", "promise": "Maquillaje que dura", "audience": "Novias"},
             "persuasion_thesis": {"avatar": "Novia de 28 que se casa en 3 meses", "angle": {"rationale": "Verse como ella misma"},
                                   "promise": "Maquillaje que dura toda la boda", "awareness_stage": "solution_aware"}},
            {"item_id": "i2", "name": "Sin datos", "status": "available", "communication_summary": None, "persuasion_thesis": None},
        ],
    },
    "campaigns": [
        {"campaign_id": "c1", "name": "Novias Meta", "status": "active",
         "boxes": [{"entity_type": "ad_set", "meta_ad_id": "120001", "metrics": {"spend": 50000, "purchases": 2}},
                   {"entity_type": "ad", "meta_ad_id": "130001", "metrics": {"spend": 50000}}]},
    ],
}


def test_seed_v2_starts_the_loop_with_bets_on_avatar_and_angle(tmp_path) -> None:
    from saleads_brain.loop import _norm, _uuid

    store = InMemoryStore()
    counts = SeedLoader(store, Ledger(tmp_path / "l.db")).load_business(json.loads(json.dumps(V2_PAYLOAD)))
    group = group_id(BUSINESS)
    nodes = store.nodes(group, 200)
    bet = next(n for n in nodes if n.type_name == "Bet")
    targets = {(e.name, store.node(group, e.target).type_name) for e in store.edges_of(group, bet.uuid)}
    assert {("TARGETS", "Avatar"), ("USES", "Angle")} <= targets
    assert bet.summary == "Maquillaje que dura toda la boda" and bet.attributes["stage"] == "lanzada"
    # El avatar usa el id de las escrituras del loop: una apuesta posterior lo reutiliza.
    assert store.node(group, _uuid(group, "Avatar", _norm("Novia de 28 que se casa en 3 meses"))) is not None
    box = next(n for n in nodes if n.type_name == "AdSet")
    assert box.attributes["canonical_id"] == "120001"
    result = next(n for n in nodes if n.type_name == "Result")
    assert result.attributes["spend"] == 50000 and result.attributes["cpa"] == 25000
    assert any(item.startswith("apuesta_sin_avatar_o_angulo") for item in counts["missing"])


def test_seed_offers_only_what_a_bet_uses_and_all_edges_are_declared(tmp_path) -> None:
    from saleads_brain.seed import declared_pair

    payload = json.loads(json.dumps(V2_PAYLOAD))
    payload["context"]["facts"]["products"].append({"id": "p2", "name": "Crema", "price": 50000, "currency": "COP"})
    store = InMemoryStore()
    SeedLoader(store, Ledger(tmp_path / "l.db")).load_business(payload)
    group = group_id(BUSINESS)
    offers = [n.name for n in store.nodes(group, 200) if n.type_name == "Offer"]
    assert offers == ["Oferta: Sérum facial"]
    for edge in store.edges(group, 500):
        source, target = store.node(group, edge.source), store.node(group, edge.target)
        assert declared_pair(edge.name, source.type_name, target.type_name), (edge.name, source.type_name, target.type_name)


def test_reseed_retires_v1_seed_but_keeps_conversation(tmp_path) -> None:
    from saleads_brain.graph import Edge, Node
    from saleads_brain.ledger import stable_id

    store = InMemoryStore()
    group = group_id(BUSINESS)
    store.upsert_node(group, Node(uuid=stable_id(group, "Hypothesis", "hyp:x"), type_name="Hypothesis", name="vieja"))
    store.upsert_node(group, Node(uuid=stable_id(group, "Offer", "offer:old"), type_name="Offer", name="Precio de Viejo"))
    store.upsert_node(group, Node(uuid="conv-1", type_name="Hypothesis", name="de la charla", provenance="conversation"))
    biz = stable_id(group, "Business", BUSINESS)
    store.upsert_node(group, Node(uuid=biz, type_name="Business", name="Example Beauty"))
    store.upsert_edge(group, Edge(source=biz, target="conv-1", name="RELATES_TO"))
    loader = SeedLoader(store, Ledger(tmp_path / "l.db"))
    first = loader.load_business(json.loads(json.dumps(V2_PAYLOAD)))
    before = len(store.nodes(group, 500))
    loader.load_business(json.loads(json.dumps(V2_PAYLOAD)))
    names = {n.name for n in store.nodes(group, 500)}
    assert "vieja" not in names and "Precio de Viejo" not in names and "de la charla" in names
    assert first["retired"] == 2 and len(store.nodes(group, 500)) == before
    assert not [e for e in store.edges(group, 500) if e.name == "RELATES_TO" and e.provenance == "saleads_seed"]


def test_snapshot_v2_has_loop_attributes_and_sections(tmp_path) -> None:
    from saleads_brain.loop import LoopWriter

    store = InMemoryStore()
    ledger = Ledger(tmp_path / "l.db")
    SeedLoader(store, ledger).load_business(json.loads(json.dumps(V2_PAYLOAD)))
    # MCB-009: la cita del dueño se da por encontrada en su chat (la búsqueda real se prueba en test_quotes).
    writer = LoopWriter(store, ledger, quote_checker=lambda _quote: "ok")
    bet = writer.record_bet(business_id=BUSINESS, statement="Mamás sin tiempo", avatar="Mamá de 35", angle="Rutina corta",
                            format="Video UGC", adset_ids=["555"], as_of="2026-10-30T10:00:00Z")
    r = writer.record_result(business_id=BUSINESS, adset_id="555", spend=60000, purchases=0, as_of="2026-10-30T10:00:00Z")
    verdict = writer.record_verdict(business_id=BUSINESS, bet_uuid=bet["bet_uuid"], outcome="pierde", reason="sin compras",
                                    result_uuids=[r["result_uuid"]], min_spend=30000, as_of="2026-11-02T11:00:00Z")
    first = writer.record_learning(business_id=BUSINESS, statement="Las mamás no compran por imagen", anchor_uuid=verdict["verdict_uuid"],
                                   confidence="baja", evidence="caja 555")
    writer.record_learning(business_id=BUSINESS, statement="Las mamás compran con video corto", anchor_uuid=verdict["verdict_uuid"],
                           confidence="media", evidence="caja 556", replaces_uuid=first["learning_uuid"])
    validated = writer.record_decision(business_id=BUSINESS, text="No muestres mujeres de 20", scope=["avatar:mamas"],
                                       owner_quote="no me muestre mujeres de 20")
    unquoted = writer.record_decision(business_id=BUSINESS, text="Prefiere videos cortos", scope=["formato"])
    snap = snapshot.build(store, generated_at="")
    jsonschema.validate(snap, SCHEMA)
    business = snap["businesses"][0]
    sections = business["sections"]
    by_id = {n["id"]: n for n in business["nodes"]}
    assert by_id[bet["bet_uuid"]]["family"] == "bet" and by_id[bet["bet_uuid"]]["type_label"] == "Apuesta"
    assert bet["bet_uuid"] in sections["did_not_work"] and verdict["verdict_uuid"] in sections["did_not_work"]
    assert first["learning_uuid"] in sections["history"] and by_id[first["learning_uuid"]]["superseded_by"]
    assert any(by_id[i]["type"] == "Learning" for i in sections["learned"])
    # Solo lo que el dueño dijo con su cita es «tus correcciones»; lo que Ale entendió sin cita queda por confirmar.
    assert sections["your_corrections"] == [validated["decision_uuid"]]
    assert unquoted["decision_uuid"] in sections["to_confirm"] and unquoted["degradado"] == "sin_cita"
    assert any(by_id[i]["type"] == "Bet" for i in sections["active_bets"])  # la apuesta del plan sembrada
    assert any(by_id[i]["type"] == "Business" for i in sections["my_business"])
