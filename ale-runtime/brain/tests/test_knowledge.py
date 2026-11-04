import copy
import hashlib
from pathlib import Path

import pytest

from saleads_brain.graph import InMemoryStore
from saleads_brain.knowledge import MemoryContext, MemoryError, MemoryWriter, validate_contract
from saleads_brain.ledger import Ledger
from saleads_brain.settings import group_id
from saleads_brain.snapshot import build

BUSINESS = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
WHEN = "2026-11-03T12:00:00Z"
CTX = MemoryContext("fixture-owner", BUSINESS)


@pytest.fixture
def writer(tmp_path):
    return MemoryWriter(Ledger(tmp_path / "ledger.db"), InMemoryStore())


def source(kind="owner_message", text="The price is 100.", event_id="source-1", **overrides):
    authors = {"owner_message": "owner", "specialist_result": "specialist", "cron_result": "cron",
               "api_observation": "api", "server_instruction": "server", "operator_canary": "operator"}
    value = {
        "schema_version": "source-event/1", "event_id": event_id, "owner_id": CTX.owner_id,
        "business_id": BUSINESS, "source_kind": kind, "source_id": event_id, "source_version": "1",
        "author": {"kind": authors[kind], "id": CTX.owner_id if kind == "owner_message" else "fixture-author"},
        "extractor_id": None, "occurred_at": WHEN, "recorded_at": WHEN, "content": text,
        "content_sha256": hashlib.sha256(text.encode()).hexdigest(), "refs": [],
        "purpose": "technical_canary" if kind == "operator_canary" else "business_work",
        "native_task_id": None, "native_run_id": None,
    }
    return {**value, **overrides}


def candidate(candidate_id="candidate-1", text="The price is 100.", **overrides):
    value = {
        "schema_version": "knowledge-candidate/1", "candidate_id": candidate_id,
        "owner_id": CTX.owner_id, "business_id": BUSINESS, "entity_type": "Offer", "content": text,
        "attributes": {"field": "price", "subject_ref": "offer-1", "value": "100"}, "source_event_ids": ["source-1"],
        "scope": "business", "specialist_role": None, "extractor_id": "curador", "epistemic": "declared",
        "validation_state": "confirmed", "valid_from": WHEN, "valid_until": None,
        "supersedes_id": None, "contradicts_id": None,
    }
    return {**value, **overrides}


def experience(**overrides):
    value = {
        "schema_version": "specialist-experience/1", "experience_id": "experience-1", "owner_id": CTX.owner_id,
        "business_id": BUSINESS, "specialist_role": "investigador", "task_id": "task-1", "run_id": "run-1",
        "method": "Check the original source before comparing prices.",
        "observed_result": "A cached summary used an expired price; the original page gave the current price.",
        "correction": "Discard the expired summary.", "lesson": "Verify freshness against the original page.",
        "applicability": "Price comparisons where a summary may be stale.", "source_event_ids": ["source-1"],
        "confidence": "supported", "valid_from": WHEN, "valid_until": None, "shared_summary": None,
    }
    return {**value, **overrides}


def goal(**overrides):
    value = {
        "schema_version": "goal-state/1", "goal_id": "goal-1", "owner_id": CTX.owner_id, "business_id": BUSINESS,
        "origin": "assistant_proposed",
        "mandate": "Research current alternatives for our offer.", "source_event_ids": ["source-1"],
        "native_task_ids": [], "state": "intake", "blockers": [], "next_condition": None,
        "next_review_at": None, "result_summary": None, "revision": 1, "updated_at": WHEN,
    }
    return {**value, **overrides}


def test_shared_contracts_are_byte_identical_in_the_python_distribution():
    root = Path(__file__).resolve().parents[2]
    files = list((root / "contracts/continuous-loop/v1").glob("*.schema.json"))
    assert len(files) == 10
    for path in files:
        assert path.read_bytes() == (root / "brain/saleads_brain/contracts/mcl" / path.name).read_bytes()


@pytest.mark.parametrize("bad", [
    {"business_id": OTHER}, {"owner_id": "other-owner"}, {"content_sha256": "0" * 64},
    {"author": {"kind": "server", "id": "server"}}, {"author": {"kind": "owner", "id": "other-owner"}},
])
def test_source_registration_rejects_forged_binding_hash_or_author(writer, bad):
    with pytest.raises(MemoryError):
        writer.register_source(CTX, source(**bad))


def test_source_identity_is_immutable_and_aliases_are_scoped(writer):
    first = writer.register_source(CTX, source(), aliases=("legacy-owner-message-9",))
    replay = source(event_id="source-replayed", source_id="source-1", extractor_id="other-extractor")
    assert writer.register_source(CTX, replay) == first
    assert writer.source(CTX, "legacy-owner-message-9")["event_id"] == first
    with pytest.raises(MemoryError, match="source_identity_conflict"):
        writer.register_source(CTX, source(text="A different immutable message."))
    with pytest.raises(MemoryError, match="source_not_found_in_business"):
        writer.source(MemoryContext(CTX.owner_id, OTHER), first)


@pytest.mark.parametrize("kind,purpose", [("operator_canary", "technical_canary"),
                                        ("server_instruction", "business_work")])
def test_an_apparent_owner_quote_in_technical_material_cannot_become_owner_knowledge(writer, kind, purpose):
    writer.register_source(CTX, source(kind, "The owner said: The price is 100.", purpose=purpose))
    with pytest.raises(MemoryError, match="non_business_source_not_admissible"):
        writer.candidate(CTX, candidate())
    assert writer.current(CTX) == []


def test_candidates_require_real_sources_and_exact_owner_content(writer):
    with pytest.raises(MemoryError, match="source_not_found_in_business"):
        writer.candidate(CTX, candidate())
    writer.register_source(CTX, source())
    with pytest.raises(MemoryError, match="owner_quote_not_in_registered_source"):
        writer.candidate(CTX, candidate(text="Invented owner statement."))
    interpreted = writer.candidate(CTX, candidate(text="This offer is guaranteed to sell.",
                                                 attributes={"owner_quote": "The price is 100."}))
    assert interpreted["payload"]["validation_state"] == "proposed"
    assert interpreted["provenance"] == "inferred"


def test_replaying_same_source_or_another_extractor_does_not_add_evidence(writer):
    writer.register_source(CTX, source(), aliases=("legacy-source-1",))
    first = writer.candidate(CTX, candidate())
    assert writer.candidate(CTX, candidate())["record_id"] == first["record_id"]
    alias = writer.candidate(CTX, candidate("candidate-2", source_event_ids=["legacy-source-1"]))
    assert alias["record_id"] == first["record_id"] and alias["evidence_count"] == 1
    writer.register_source(CTX, source(event_id="source-2"))
    new = writer.candidate(CTX, candidate("candidate-3", source_event_ids=["source-2"]))
    assert new["record_id"] == first["record_id"] and new["evidence_count"] == 2
    assert len(writer.current(CTX)) == 1
    assert len([n for n in writer.store.nodes(group_id(BUSINESS), 100) if n.type_name == "Offer"]) == 1


def test_reusing_a_candidate_id_with_changed_content_is_rejected(writer):
    writer.register_source(CTX, source(text="The price is 100. We open on Monday."))
    writer.candidate(CTX, candidate())
    with pytest.raises(MemoryError, match="candidate_idempotency_conflict"):
        writer.candidate(CTX, candidate(text="We open on Monday."))


def test_observed_api_fact_remains_an_api_source_during_canary(writer):
    writer.register_source(CTX, source("api_observation", '{"spend": 5}', refs=["agent-api:campaign-1/window-1"]))
    actual = writer.candidate(CTX, candidate(text="Spend is 5.", entity_type="Campaign", epistemic="observed",
                                            attributes={"field": "spend", "subject_ref": "campaign-1", "value": 5}))
    assert actual["provenance"] == "platform" and actual["payload"]["validation_state"] == "confirmed"
    wrong = writer.candidate(CTX, candidate("wrong", "Spend is 1000.", entity_type="Campaign", epistemic="observed",
                                           attributes={"field": "spend", "subject_ref": "campaign-1", "value": 1000}))
    assert wrong["provenance"] == "inferred_from_platform" and wrong["payload"]["validation_state"] == "proposed"


def test_inference_cannot_replace_confirmed_fact_and_history_remains(writer):
    writer.register_source(CTX, source())
    original = writer.candidate(CTX, candidate())
    proposed = writer.candidate(CTX, candidate("inference", "A lower price might perform better.",
        epistemic="inferred", validation_state="proposed", supersedes_id="candidate-1",
        attributes={"field": "price", "subject_ref": "offer-1", "value": "90"}))
    assert not proposed["effective"]
    assert writer.get(CTX, "candidate-1")["effective"]
    assert original["record_id"] != proposed["record_id"]
    with pytest.raises(MemoryError, match="inference_is_not_confirmed_fact"):
        writer.candidate(CTX, candidate("bad-inference", epistemic="inferred"))


def test_explicit_owner_correction_replaces_current_without_deleting_history(writer):
    writer.register_source(CTX, source())
    old = writer.candidate(CTX, candidate())
    writer.register_source(CTX, source(text="The price is now 120.", event_id="source-2"))
    corrected = writer.candidate(CTX, candidate("correction", "The price is now 120.",
        source_event_ids=["source-2"], supersedes_id=old["record_id"],
        attributes={"field": "price", "subject_ref": "offer-1", "value": "120"}))
    assert corrected["effective"] and corrected["payload"]["validation_state"] == "confirmed"
    preserved = writer.get(CTX, "candidate-1")
    assert preserved["superseded_by"] == corrected["record_id"] and not preserved["effective"]
    assert preserved["payload"]["content"] == "The price is 100."


def test_ambiguous_declared_conflict_keeps_last_confirmed_value(writer):
    writer.register_source(CTX, source())
    writer.candidate(CTX, candidate())
    writer.register_source(CTX, source(text="The price could be 120.", event_id="source-2"))
    conflict = writer.candidate(CTX, candidate("ambiguous", "The price could be 120.",
        source_event_ids=["source-2"], contradicts_id="candidate-1",
        attributes={"field": "price", "subject_ref": "offer-1", "value": "120"}))
    assert conflict["payload"]["validation_state"] == "pending_conflict" and not conflict["effective"]
    assert writer.get(CTX, "candidate-1")["effective"]


def test_owner_recall_never_replaces_a_platform_measurement(writer):
    writer.register_source(CTX, source("api_observation", '{"spend": 5}'))
    writer.candidate(CTX, candidate(text="Spend is 5.", entity_type="Campaign", epistemic="observed",
                                   attributes={"field": "spend", "subject_ref": "campaign-1", "value": 5}))
    writer.register_source(CTX, source(text="Spend was 1.", event_id="owner-recall"))
    recall = writer.candidate(CTX, candidate("recall", "Spend was 1.", entity_type="Campaign",
        source_event_ids=["owner-recall"], supersedes_id="candidate-1",
        attributes={"field": "spend", "subject_ref": "campaign-1", "value": 1}))
    assert not recall["effective"] and writer.get(CTX, "candidate-1")["effective"]


def test_proof_is_not_validated_merely_because_it_was_mentioned(writer):
    writer.register_source(CTX, source(text="Our product guarantees success."))
    out = writer.candidate(CTX, candidate(text="Our product guarantees success.", entity_type="Proof", attributes={}))
    assert out["payload"]["validation_state"] == "proposed"


@pytest.mark.parametrize("patch", [
    {"business_id": OTHER}, {"entity_type": "NotAType"}, {"entity_type": "Bet"},
    {"scope": "specialist", "specialist_role": None}, {"extractor_id": "other-extractor"},
    {"valid_until": "2026-10-29T12:00:00Z"},
    {"attributes": {"field": "price", "value": 100}},
])
def test_invalid_candidates_never_create_nodes(writer, patch):
    writer.register_source(CTX, source())
    with pytest.raises(MemoryError):
        writer.candidate(CTX, candidate(**patch))
    assert writer.store.groups() == []


def test_projection_restarts_from_committed_ledger_without_another_admission(tmp_path):
    class InterruptedStore(InMemoryStore):
        fail = True

        def upsert_node(self, group, node):
            if self.fail:
                raise ConnectionError("controlled projection interruption")
            return super().upsert_node(group, node)

    store = InterruptedStore()
    writer = MemoryWriter(Ledger(tmp_path / "ledger.db"), store)
    writer.register_source(CTX, source())
    with pytest.raises(ConnectionError):
        writer.candidate(CTX, candidate())
    assert writer.get(CTX, "candidate-1")["projection_status"] == "pending"
    store.fail = False
    recovered = MemoryWriter(Ledger(tmp_path / "ledger.db"), store)
    assert recovered.reconcile(CTX) == 1
    assert recovered.candidate(CTX, candidate())["evidence_count"] == 1
    assert recovered.reconcile(CTX) == 0


def test_individual_experience_has_native_role_scope_and_is_not_exposed_in_snapshot(writer):
    writer.register_source(CTX, source("specialist_result", "Research completed.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    saved = writer.experience(CTX, experience(confidence="validated"))
    assert saved["payload"]["confidence"] == "supported"
    assert writer.get(MemoryContext(CTX.owner_id, BUSINESS, "investigador"), "experience-1")["record_id"] == saved["record_id"]
    for role in ("estratega", "ale"):
        with pytest.raises(MemoryError, match="private_experience_role_mismatch"):
            writer.get(MemoryContext(CTX.owner_id, BUSINESS, role), "experience-1")
        assert writer.current(MemoryContext(CTX.owner_id, BUSINESS, role)) == []
        with pytest.raises(MemoryError, match="private_source_role_mismatch"):
            writer.source(MemoryContext(CTX.owner_id, BUSINESS, role), "source-1")
    assert all(n["type"] != "SpecialistExperience" for b in build(writer.store)["businesses"] for n in b["nodes"])
    with pytest.raises(MemoryError, match="experience_requires_native_role_result"):
        writer.experience(CTX, experience(experience_id="wrong-role", specialist_role="estratega"))


def test_curator_promotes_a_business_summary_with_lineage_instead_of_private_transcript(writer):
    from saleads_brain.graph import Node

    writer.store.upsert_node(group_id(BUSINESS), Node("business-node", "Business", "Fixture Business"))
    writer.register_source(CTX, source("specialist_result", "Research completed.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    saved = writer.experience(CTX, experience())
    summary = writer.candidate(CTX, candidate("summary", "Price evidence may expire; verify freshness.",
        entity_type="Research", attributes={"derived_from_ref": "experience-1"},
        epistemic="inferred", validation_state="proposed"))
    seen = writer.current(MemoryContext(CTX.owner_id, BUSINESS, "estratega"))
    assert [record["record_id"] for record in seen] == [summary["record_id"]]
    edges = writer.store.edges(group_id(BUSINESS), 100)
    assert any(edge.name == "ABOUT" and edge.target == "business-node" for edge in edges)
    assert any(edge.name == "DERIVED_FROM" and edge.target.replace("-", "") == saved["record_id"] for edge in edges)
    assert "cached summary" not in seen[0]["payload"]["content"]


def test_scalar_change_is_not_admitted_as_a_second_current_price_when_replacement_ref_is_omitted(writer):
    writer.register_source(CTX, source())
    writer.candidate(CTX, candidate())
    writer.register_source(CTX, source(text="The price is now 120.", event_id="source-2"))
    changed = writer.candidate(CTX, candidate("new-price", "The price is now 120.",
        source_event_ids=["source-2"], attributes={"subject_ref": "offer-1", "field": "price", "value": "120"}))
    assert changed["revision"] == 2
    assert len(writer.current(CTX)) == 1
    assert writer.get(CTX, "candidate-1")["superseded_by"] == changed["record_id"]


def test_goal_intake_is_optional_and_revisions_are_scoped_and_idempotent(writer):
    assert writer.goal(CTX) is None
    writer.register_source(CTX, source())
    saved = writer.put_goal(CTX, goal())
    assert writer.put_goal(CTX, goal()) == saved
    assert writer.goal(MemoryContext(CTX.owner_id, OTHER)) is None
    with pytest.raises(MemoryError, match="goal_revision_conflict"):
        writer.put_goal(CTX, goal(mandate="A different mandate with the same revision."))
    with pytest.raises(MemoryError, match="goal_wait_requires_condition"):
        writer.put_goal(CTX, goal(state="waiting", revision=2))
    writer.put_goal(CTX, goal(state="waiting", revision=2, next_condition="Wait for the owner's objective."))
    assert writer.goal(CTX)["revision"] == 2


def test_schema_validator_does_not_accept_undeclared_properties():
    bad = copy.deepcopy(candidate())
    bad["provenance"] = "owner_decided"
    with pytest.raises(MemoryError, match="invalid_knowledge_candidate_contract"):
        validate_contract("knowledge-candidate", bad)
