import json

from saleads_brain import snapshot
from saleads_brain.analyze import analyze
from saleads_brain.decay import decay
from saleads_brain.graph import Edge, InMemoryStore, Node
from saleads_brain.ledger import Ledger
from saleads_brain.loop import LoopWriter
from saleads_brain.ontology import ontology_for_event
from saleads_brain.settings import group_id

A = "00000000-0000-4000-8000-0000000000aa"
B = "00000000-0000-4000-8000-0000000000bb"


def concept(store: InMemoryStore, business: str, episodes: list[tuple[str, str]]) -> str:
    group = group_id(business)
    store.upsert_node(group, Node(uuid=f"biz-{business}", type_name="Business", name="Negocio"))
    store.upsert_node(group, Node(uuid=f"pkg-{business}", type_name="Entity", name="paquete madre novia", provenance="conversation"))
    store.upsert_edge(group, Edge(source=f"biz-{business}", target=f"pkg-{business}", name="SELLS", provenance="conversation"))
    store.episodes.setdefault(group, {})[f"pkg-{business}"] = episodes
    return group


def test_type_activated_in_one_business_never_reaches_the_other(tmp_path) -> None:
    store, ledger = InMemoryStore(), Ledger(tmp_path / "l.db")
    concept(store, A, [("e1", "session-1"), ("e2", "session-2"), ("e3", "session-3")])
    concept(store, B, [("e9", "session-9")])
    out = analyze(store, ledger, tmp_path / "learned")
    assert out == {"proposed": 1, "activated": 1}
    learned_a = json.loads((tmp_path / "learned" / f"{A}.json").read_text())
    assert [p["name"] for p in learned_a["proposals"]] == ["PaqueteMadreNovia"]
    assert learned_a["proposals"][0]["schema"]["extends"] == "ProductOrService"
    assert not (tmp_path / "learned" / f"{B}.json").exists()
    entities_a, _ = ontology_for_event("business_profile", tmp_path / "learned" / f"{A}.json")
    entities_b, _ = ontology_for_event("business_profile", tmp_path / "learned" / f"{B}.json")
    assert "PaqueteMadreNovia" in entities_a and "PaqueteMadreNovia" not in entities_b


def test_many_mentions_in_one_episode_or_one_session_do_not_propose(tmp_path) -> None:
    store, ledger = InMemoryStore(), Ledger(tmp_path / "l.db")
    concept(store, A, [("e1", "session-1"), ("e1", "session-1"), ("e1", "session-1")])
    assert analyze(store, ledger, tmp_path / "learned") == {"proposed": 0, "activated": 0}
    store2 = InMemoryStore()
    concept(store2, A, [("e1", "session-1"), ("e2", "session-1"), ("e3", "session-1")])
    assert analyze(store2, ledger, tmp_path / "learned") == {"proposed": 0, "activated": 0}


def test_sensitive_concepts_stay_proposed_for_the_owner(tmp_path) -> None:
    store, ledger = InMemoryStore(), Ledger(tmp_path / "l.db")
    group = concept(store, A, [("e1", "session-1"), ("e2", "session-2"), ("e3", "session-3")])
    node = store.node(group, f"pkg-{A}")
    store.upsert_node(group, Node(uuid=node.uuid, type_name="Entity", name="presupuesto gasto diario", provenance="conversation"))
    out = analyze(store, ledger, tmp_path / "learned")
    assert out["proposed"] == 1 and out["activated"] == 0


def test_decay_lowers_confidence_after_60_days_without_deleting(tmp_path) -> None:
    store, ledger = InMemoryStore(), Ledger(tmp_path / "l.db")
    writer = LoopWriter(store, ledger)
    bet = writer.record_bet(business_id=A, statement="s", avatar="a", angle="b", format="c", adset_ids=["1"], as_of="2026-11-01T00:00:00Z")
    r = writer.record_result(business_id=A, adset_id="1", spend=100, purchases=1, as_of="2026-11-01T00:00:00Z")
    v = writer.record_verdict(business_id=A, bet_uuid=bet["bet_uuid"], outcome="gana", reason="r", result_uuids=[r["result_uuid"]],
                              min_spend=10, as_of="2026-11-02T01:00:00Z")
    learning = writer.record_learning(business_id=A, statement="Video corto vende", anchor_uuid=v["verdict_uuid"], confidence="alta",
                                      evidence="caja 1", as_of="2026-10-31T00:00:00Z")
    group = group_id(A)
    assert decay(store, "2026-11-01T00:00:00Z") == {"lowered": 0}
    assert decay(store, "2026-11-02T00:00:00Z") == {"lowered": 1}
    assert store.node(group, learning["learning_uuid"]).attributes["confidence"] == "media"
    assert decay(store, "2026-11-02T00:00:00Z") == {"lowered": 0}  # 60 días desde el último decaimiento
    assert decay(store, "2026-10-29T00:00:00Z") == {"lowered": 1}
    assert decay(store, "2026-10-27T00:00:00Z") == {"lowered": 0}  # «baja» no baja más
    node = store.node(group, learning["learning_uuid"])
    assert node is not None and node.attributes["confidence"] == "baja" and node.attributes["stage"] == "vigente"


def test_untyped_unlinked_nodes_are_quarantined_from_the_snapshot(tmp_path) -> None:
    store = InMemoryStore()
    group = concept(store, A, [])
    store.upsert_node(group, Node(uuid="loose", type_name="Entity", name="cosa suelta", provenance="conversation"))
    ids = {n["id"] for n in snapshot.build(store, generated_at="")["businesses"][0]["nodes"]}
    assert "loose" not in ids and f"pkg-{A}" in ids
