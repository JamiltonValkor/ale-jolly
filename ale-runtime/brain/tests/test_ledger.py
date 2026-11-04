from saleads_brain.ledger import Ledger
from saleads_brain.provenance import Provenance
from saleads_brain.states import VISIBLE_STATE, VerificationState, VisibleState


def test_all_eight_states_map_to_four() -> None:
    assert set(VISIBLE_STATE) == set(VerificationState)
    assert set(VISIBLE_STATE.values()) == set(VisibleState)


def test_events_are_idempotent_and_feed_outbox(tmp_path) -> None:
    ledger = Ledger(tmp_path / "l.db")
    args = dict(
        business_id="b1",
        kind="business_profile",
        provenance=Provenance.SALEADS_SEED,
        source_uri="seed://1",
        occurred_at="2026-11-01T00:00:00Z",
        payload={"brand_name": "Example Beauty"},
    )
    first = ledger.record_event(**args)
    second = ledger.record_event(**args)
    assert first == second
    pending = ledger.pending_outbox()
    assert len(pending) == 1
    ledger.complete_outbox(pending[0]["id"])
    assert ledger.pending_outbox() == []


def test_knowledge_is_bitemporal_and_never_overwritten(tmp_path) -> None:
    ledger = Ledger(tmp_path / "l.db")
    v1 = ledger.record_knowledge(
        business_id="b1",
        statement="El público principal son novias",
        provenance=Provenance.OWNER_SAID,
        verification=VerificationState.SELF_REPORTED,
        evidence_refs=["chat:1"],
        valid_from="2026-10-31T00:00:00Z",
    )
    v2 = ledger.record_knowledge(
        business_id="b1",
        statement="El público principal son quinceañeras",
        provenance=Provenance.OWNER_DECIDED,
        verification=VerificationState.HUMAN_VALIDATED,
        evidence_refs=["chat:9"],
        valid_from="2026-10-27T00:00:00Z",
        supersedes_revision_id=v1["revision_id"],
    )
    assert v2["canonical_id"] == v1["canonical_id"] and v2["version"] == 2
    before = ledger.knowledge_at(v1["canonical_id"], valid_at="2026-10-28T00:00:00Z", known_at=v1["recorded_at"])
    assert [k["version"] for k in before] == [1]
    now = ledger.knowledge_at(v1["canonical_id"], valid_at="2026-10-30T00:00:00Z", known_at="2026-10-29T00:00:00Z")
    assert [k["version"] for k in now] == [2]
    assert now[0]["visible_state"] == "validated"


def test_reinforcing_the_same_episode_does_not_create_independent_evidence(tmp_path) -> None:
    ledger = Ledger(tmp_path / "l.db")
    recorded = ledger.record_knowledge(
        business_id="b1", statement="Check freshness before comparing.", provenance=Provenance.INFERRED,
        verification=VerificationState.INFERRED, evidence_refs=["episode:1", "graph:anchor"],
    )
    replay = ledger.reinforce_knowledge(recorded["revision_id"], ["episode:1", "graph:anchor"])
    assert replay["evidence_count"] == recorded["evidence_count"] == 1
    independent = ledger.reinforce_knowledge(recorded["revision_id"], ["episode:2"])
    assert independent["evidence_count"] == 2


def test_legacy_supersession_rejects_other_business_without_changing_original(tmp_path) -> None:
    import pytest

    ledger = Ledger(tmp_path / "l.db")
    original = ledger.record_knowledge(
        business_id="b1", statement="Original", provenance=Provenance.OWNER_SAID,
        verification=VerificationState.SELF_REPORTED, evidence_refs=["episode:1"],
    )
    with pytest.raises(ValueError, match="knowledge_supersedes_cross_business"):
        ledger.record_knowledge(
            business_id="b2", statement="Replacement", provenance=Provenance.OWNER_SAID,
            verification=VerificationState.SELF_REPORTED, evidence_refs=["episode:2"],
            supersedes_revision_id=original["revision_id"],
        )
