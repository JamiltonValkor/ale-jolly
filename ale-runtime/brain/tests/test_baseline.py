import copy
import json
from dataclasses import replace

from fixtures_seed import SEED
from test_knowledge import BUSINESS, CTX, OTHER, candidate, source

from saleads_brain.baseline import BootstrapMemory
from saleads_brain.graph import InMemoryStore, Node
from saleads_brain.knowledge import MemoryWriter
from saleads_brain.ledger import Ledger
from saleads_brain.recall import MemoryRecall
from saleads_brain.settings import group_id


def fixture(tmp_path):
    data = copy.deepcopy(SEED)
    data["businesses"][0]["business_id"] = BUSINESS
    other = copy.deepcopy(data["businesses"][0])
    other["business_id"] = OTHER
    other["context"]["facts"]["business"]["name"] = "Other Hidden Business"
    other["context"]["facts"]["business"]["website"] = "https://other-fixture.example"
    data["businesses"].append(other)
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(data))
    memory = MemoryWriter(Ledger(tmp_path / "ledger.db"), InMemoryStore())
    baseline = BootstrapMemory(memory, path, CTX.owner_id)
    return data, path, memory, baseline


def test_actual_structured_api_snapshot_is_automatic_and_old_owner_notes_are_not_promoted(tmp_path):
    _, _, memory, baseline = fixture(tmp_path)
    memory.store.upsert_node(group_id(BUSINESS), Node("old-assertion", "OwnerNote", "An unproven historic owner note.",
                                                    provenance="owner_said"))
    recovered = MemoryRecall(memory, baseline).retrieve(replace(CTX, actor_role="ale"), "Research competitors.")
    assert any("Example Beauty" in entry["content"] for entry in recovered["knowledge"])
    assert not any("unproven" in entry["content"] or "Other Hidden" in entry["content"]
                   for entry in recovered["knowledge"])
    assert recovered["refs"]
    registered = memory.source(CTX, recovered["refs"][0])
    assert registered["source_kind"] == "api_observation" and registered["author"]["kind"] == "api"
    assert "Other Hidden" not in registered["content"]
    assert all(entry["epistemic"] == "observed" and entry["extractor_id"] == "bootstrap-bridge"
               for entry in recovered["knowledge"])


def test_seed_version_changes_get_new_recoverable_refs_without_overwriting_previous_snapshot(tmp_path):
    data, path, memory, baseline = fixture(tmp_path)
    first = baseline.entries(CTX, [])
    old_ref = first[0]["payload"]["source_event_ids"][0]
    old_content = memory.source(CTX, old_ref)["content"]
    data["businesses"][0]["context"]["facts"]["products"][0]["price"] = 99000
    path.write_text(json.dumps(data))
    second = baseline.entries(CTX, [])
    new_ref = second[0]["payload"]["source_event_ids"][0]
    assert new_ref != old_ref
    assert memory.source(CTX, old_ref)["content"] == old_content
    assert '"value":99000' in memory.source(CTX, new_ref)["content"]
    assert baseline.entries(CTX, []) == second


def test_confirmed_owner_scalar_shadows_the_matching_older_api_snapshot_field(tmp_path):
    _, _, memory, baseline = fixture(tmp_path)
    memory.register_source(CTX, source(text="The price is now 120.", event_id="owner-correction"))
    memory.candidate(CTX, candidate(text="The price is now 120.", source_event_ids=["owner-correction"],
        attributes={"field": "price", "subject_ref": "product:p1", "value": 120}))
    entries = baseline.entries(CTX, memory.current(CTX))
    assert not any(entry["payload"]["entity_type"] == "Offer" and entry["payload"]["attributes"]["field"] == "price"
                   for entry in entries)
    recovered = MemoryRecall(memory, baseline).retrieve(replace(CTX, actor_role="ale"), "Current price.")
    assert any(entry["content"] == "The price is now 120." for entry in recovered["knowledge"])
    assert not any("89000" in entry["content"] for entry in recovered["knowledge"])


def test_business_b_receives_only_its_own_api_snapshot(tmp_path):
    _, _, memory, baseline = fixture(tmp_path)
    context = replace(CTX, business_id=OTHER, actor_role="investigador")
    recovered = MemoryRecall(memory, baseline).retrieve(context, "Research competitors.")
    assert any("Other Hidden Business" in entry["content"] for entry in recovered["knowledge"])
    assert all(entry["business_id"] == OTHER for entry in recovered["knowledge"])
    assert not any("Example Beauty" in entry["content"] for entry in recovered["knowledge"])


def test_bootstrap_v2_product_ids_voice_and_existing_objectives_are_not_lost(tmp_path):
    data, path, memory, baseline = fixture(tmp_path)
    facts = data["businesses"][0]["context"]["facts"]
    facts["products"][0]["product_id"] = facts["products"][0].pop("id")
    facts["brand"] = {"voice": ["Clear", "Friendly"]}
    facts["business"]["value_proposition"] = "Convenient specialist care."
    facts["marketing"]["goals"] = ["Increase service appointments.", "Improve repeat visits."]
    path.write_text(json.dumps(data))
    recovered = MemoryRecall(memory, baseline).retrieve(replace(CTX, actor_role="ale"), "Empieza revisando lo que sabes.")
    entries = baseline.entries(CTX, [])
    assert any(entry["payload"]["entity_type"] == "ProductOrService"
               and entry["payload"]["attributes"]["subject_ref"] == "product:p1" for entry in entries)
    assert any(entry["payload"]["attributes"]["field"] == "voice_notes"
               and entry["payload"]["attributes"]["value"] == "Clear | Friendly" for entry in entries)
    assert any(entry["payload"]["attributes"]["field"] == "positioning" for entry in entries)
    assert any(entry["entity_type"] == "Goal" and "appointments" in entry["content"] for entry in recovered["knowledge"])
    ref = entries[0]["payload"]["source_event_ids"][0]
    original = memory.source(CTX, ref)
    assert original["source_kind"] == "api_observation" and ":view-2:chunk-" in original["source_version"]
    assert all(entry["payload"]["attributes"]["source_projection"] == "bootstrap-view/2" for entry in entries)


def test_late_catalog_item_is_retrievable_across_bounded_chunks_without_independent_evidence_inflation(tmp_path):
    data, path, memory, baseline = fixture(tmp_path)
    products = [{"product_id": f"p{index}", "name": f"Catalog item {index}",
                 "description": "Detailed source description. " * 25, "price": index + 1, "currency": "COP"}
                for index in range(70)]
    products[-1]["name"] = "LateCatalogSentinel"
    data["businesses"][0]["context"]["facts"]["products"] = products
    path.write_text(json.dumps(data))
    entries = baseline.entries(CTX, [])
    subjects = {entry["payload"]["attributes"]["subject_ref"] for entry in entries
                if entry["payload"]["entity_type"] == "ProductOrService"}
    assert len(subjects) == 70 and "product:p69" in subjects
    refs = {ref for entry in entries for ref in entry["payload"]["source_event_ids"]}
    sources = [memory.source(CTX, ref) for ref in refs]
    assert len(refs) > 1
    assert len({source["_evidence_key"] for source in sources}) == 1
    assert all(len(source["content"]) <= 24000 for source in sources)
    recalled = MemoryRecall(memory, baseline).retrieve(replace(CTX, actor_role="ale"), "LateCatalogSentinel", max_chars=5600)
    assert any(entry["attributes"]["subject_ref"] == "product:p69" for entry in recalled["knowledge"])
    assert recalled["size_chars"] <= 5600 and recalled["truncated"]
    with memory.ledger.connect() as db:
        before = db.execute("SELECT COUNT(*) FROM memory_sources").fetchone()[0]
    assert baseline.entries(CTX, []) == entries
    with memory.ledger.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM memory_sources").fetchone()[0] == before
