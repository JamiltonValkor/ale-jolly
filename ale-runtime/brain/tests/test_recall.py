import json
from dataclasses import replace

import pytest
from test_knowledge import BUSINESS, CTX, OTHER, candidate, experience, source

from saleads_brain.graph import InMemoryStore
from saleads_brain.knowledge import MemoryContext, MemoryWriter
from saleads_brain.ledger import Ledger
from saleads_brain.recall import MemoryRecall


def ready(tmp_path):
    writer = MemoryWriter(Ledger(tmp_path / "ledger.db"), InMemoryStore())
    writer.register_source(CTX, source("specialist_result", "Research completed.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    writer.experience(CTX, experience())
    return writer


def test_new_session_recovers_relevant_role_experience_after_restart(tmp_path):
    original = ready(tmp_path)
    writer = MemoryWriter(Ledger(tmp_path / "ledger.db"), original.store)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "Compare current prices.")
    assert result["experiences"][0]["experience_id"] == "experience-1"
    assert result["refs"] == ["source-1"]


def test_irrelevant_other_role_and_other_business_receive_no_private_capsule(tmp_path):
    recall = MemoryRecall(ready(tmp_path))
    assert recall.retrieve(replace(CTX, actor_role="investigador"), "Schedule a meeting.")["experiences"] == []
    for context in (replace(CTX, actor_role="estratega"), replace(CTX, actor_role="ale"),
                    MemoryContext(CTX.owner_id, OTHER, "investigador")):
        assert recall.retrieve(context, "Compare current prices.")["experiences"] == []


def test_expired_experience_is_identified_and_not_forced_into_context(tmp_path):
    writer = ready(tmp_path)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "Compare prices.",
        at="2026-10-27T12:00:00Z")
    assert result["experiences"] == []
    assert result["excluded"][0]["reason"] == "outside_validity"


def test_team_summary_does_not_share_the_private_method_or_transcript(tmp_path):
    writer = ready(tmp_path)
    writer.candidate(CTX, candidate("promoted", "Verify the current price against recent source evidence.",
        entity_type="Research", attributes={"derived_from_ref": "experience-1"},
        epistemic="inferred", validation_state="proposed"))
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="estratega"), "Compare current prices.")
    assert result["knowledge"] and not result["experiences"]
    assert all(item["business_id"] == BUSINESS for item in result["knowledge"])
    assert "cached summary" not in str(result["knowledge"])


def test_effective_payload_budget_is_explicit_and_never_spills_to_a_file(tmp_path):
    recall = MemoryRecall(ready(tmp_path))
    result = recall.retrieve(replace(CTX, actor_role="investigador"), "Compare current prices.", max_chars=10)
    assert result["experiences"] == [] and result["truncated"]
    assert result["size_chars"] <= 10


def test_confirmed_english_constraint_is_recovered_for_a_spanish_query_without_translation_model(tmp_path):
    writer = ready(tmp_path)
    statement = "Never publish campaigns before I approve them."
    writer.register_source(CTX, source(text=statement, event_id="owner-restriction"))
    writer.candidate(CTX, candidate("standing", statement, entity_type="Decision", attributes={},
                                    source_event_ids=["owner-restriction"]))
    recalled = MemoryRecall(writer).retrieve(replace(CTX, actor_role="analista"), "Revisa la publicidad del negocio.")
    assert any(entry["candidate_id"] == "standing" for entry in recalled["knowledge"])
    assert MemoryRecall(writer).retrieve(MemoryContext(CTX.owner_id, OTHER, "analista"), "Revisa la publicidad.")["knowledge"] == []


@pytest.mark.parametrize("field", ["correction", "observed_result"])
def test_experience_relevance_includes_its_correction_and_observed_result(tmp_path, field):
    writer = MemoryWriter(Ledger(tmp_path / "ledger.db"), InMemoryStore())
    writer.register_source(CTX, source("specialist_result", "Research completed.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    record = writer.experience(CTX, experience(**{field: "UniqueExperienceEvidenceSentinel"}))
    recall = MemoryRecall(writer)
    recovered = recall.retrieve(replace(CTX, actor_role="investigador"), "UniqueExperienceEvidenceSentinel")
    assert [entry["experience_id"] for entry in recovered["experiences"]] == ["experience-1"]
    assert recovered["versions"] == {record["record_id"]: record["revision"]}
    assert recovered["refs"] == ["source-1"]
    for context in (replace(CTX, actor_role="estratega"), MemoryContext(CTX.owner_id, OTHER, "investigador")):
        assert recall.retrieve(context, "UniqueExperienceEvidenceSentinel")["experiences"] == []


def test_experience_indexing_does_not_displace_confirmed_standing_constraints(tmp_path):
    writer = ready(tmp_path)
    statement = "Never publish campaigns before I approve them."
    writer.register_source(CTX, source(text=statement, event_id="owner-restriction"))
    record = writer.candidate(CTX, candidate("standing", statement, entity_type="Decision", attributes={},
                                            source_event_ids=["owner-restriction"]))
    budget = len(json.dumps(record["payload"], ensure_ascii=False)) + 20
    recovered = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "Compare current prices.",
                                             max_chars=budget)
    assert [entry["candidate_id"] for entry in recovered["knowledge"]] == ["standing"]
    assert recovered["experiences"] == [] and recovered["truncated"]
    assert recovered["versions"] == {record["record_id"]: record["revision"]}
    assert recovered["refs"] == ["owner-restriction"]


PRIORITY_QUERY = "market research evidence primary sources method uncertainty practical lesson correction"


def sized_payload(payload, field, chars):
    cost = len(json.dumps(payload, ensure_ascii=False))
    assert cost < chars
    payload[field] += "q" * (chars - cost)
    assert len(json.dumps(payload, ensure_ascii=False)) == chars
    return payload


def competing_role_memory(tmp_path, **experience_overrides):
    writer = MemoryWriter(Ledger(tmp_path / "ledger.db"), InMemoryStore())
    writer.register_source(CTX, source("specialist_result", "A synthetic discovery report.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    item = experience(
        method="Checked the current synthetic catalogue.", observed_result="Recorded a synthetic discovery outcome. ",
        correction="Selected the designated service rather than test inventory.",
        lesson="For a mixed test catalogue, verify the designated priority offering before discovery research.",
        applicability="Multi-offering discovery research involving simulated catalogue items.",
        **experience_overrides,
    )
    personal = writer.experience(CTX, sized_payload(item, "observed_result", 2139))
    writer.register_source(CTX, source("specialist_result", "A synthetic general report.", event_id="source-research",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-2", native_run_id="run-2"))
    general = writer.candidate(CTX, sized_payload(candidate("generic-research", PRIORITY_QUERY + " Fixture summary. ",
        entity_type="Research", attributes={}, source_event_ids=["source-research"],
        epistemic="inferred", validation_state="proposed"), "content", 4500))
    return writer, personal, general


def test_matching_own_experience_survives_higher_ranked_ordinary_knowledge_within_budget(tmp_path):
    writer, personal, _general = competing_role_memory(tmp_path)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), PRIORITY_QUERY, max_chars=6000)
    assert result["experiences"] == [personal["payload"]]
    assert result["knowledge"] == [] and result["truncated"]
    assert result["size_chars"] == 2139
    assert result["versions"] == {personal["record_id"]: personal["revision"]}
    assert result["entry_ids"] == {personal["record_id"]: "experience-1"}
    assert result["refs"] == ["source-1"]


def test_ordinary_knowledge_fills_the_budget_after_matching_own_experience(tmp_path):
    writer, personal, general = competing_role_memory(tmp_path)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), PRIORITY_QUERY, max_chars=8000)
    assert result["experiences"] == [personal["payload"]]
    assert result["knowledge"] == [general["payload"]]
    assert not result["truncated"] and result["size_chars"] == 6639
    assert result["versions"] == {r["record_id"]: r["revision"] for r in (personal, general)}
    assert result["refs"] == ["source-1", "source-research"]


def test_private_experience_ranking_and_maximum_remain_stable_when_groups_are_prioritized(tmp_path):
    writer, _personal, _general = competing_role_memory(tmp_path)
    writer.register_source(CTX, source("specialist_result", "Another synthetic research report.",
        event_id="source-second", author={"kind": "specialist", "id": "investigador"},
        native_task_id="task-second", native_run_id="run-second"))
    second = writer.experience(CTX, experience(experience_id="experience-second", task_id="task-second",
        run_id="run-second", source_event_ids=["source-second"], lesson=PRIORITY_QUERY))
    recall, context = MemoryRecall(writer), replace(CTX, actor_role="investigador")
    ranked = recall.retrieve(context, PRIORITY_QUERY, max_knowledge=0, max_chars=6000)
    assert [entry["experience_id"] for entry in ranked["experiences"]] == ["experience-second", "experience-1"]
    limited = recall.retrieve(context, PRIORITY_QUERY, max_experiences=1, max_knowledge=0, max_chars=6000)
    assert limited["experiences"] == [second["payload"]] and limited["truncated"]
    assert limited["refs"] == ["source-second"]
    assert limited["versions"] == {second["record_id"]: second["revision"]}


def test_matching_private_experience_precedes_structured_bootstrap_when_only_one_fits(tmp_path):
    from test_baseline import fixture

    _data, _path, writer, baseline = fixture(tmp_path)
    writer.register_source(CTX, source("specialist_result", "A synthetic research report.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    personal = writer.experience(CTX, experience())
    budget = len(json.dumps(personal["payload"], ensure_ascii=False)) + 1
    result = MemoryRecall(writer, baseline).retrieve(replace(CTX, actor_role="investigador"),
        "Compare current prices.", max_chars=budget)
    assert result["experiences"] == [personal["payload"]]
    assert not result["knowledge"] and result["truncated"]
    assert result["refs"] == ["source-1"]
    assert result["versions"] == {personal["record_id"]: personal["revision"]}


def test_confirmed_constraint_remains_ahead_of_matching_personal_experience(tmp_path):
    writer, _personal, _general = competing_role_memory(tmp_path)
    constraint = sized_payload(candidate("standing", "Synthetic authorization boundary. ", entity_type="Decision",
        attributes={}, source_event_ids=["source-standing"]), "content", 4500)
    writer.register_source(CTX, source(text=constraint["content"], event_id="source-standing"))
    record = writer.candidate(CTX, constraint)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), PRIORITY_QUERY, max_chars=6000)
    assert result["knowledge"] == [record["payload"]]
    assert result["experiences"] == [] and result["truncated"]
    assert result["versions"] == {record["record_id"]: record["revision"]}
    assert result["refs"] == ["source-standing"]


@pytest.mark.parametrize("role", ["ale", "estratega"])
def test_role_priority_keeps_shared_knowledge_without_exposing_another_roles_experience(tmp_path, role):
    writer, _personal, general = competing_role_memory(tmp_path)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role=role), PRIORITY_QUERY, max_chars=6000)
    assert result["knowledge"] == [general["payload"]]
    assert not result["experiences"] and not result["truncated"]
    assert result["versions"] == {general["record_id"]: general["revision"]}
    assert result["refs"] == ["source-research"]
    for context in (MemoryContext(CTX.owner_id, OTHER, "investigador"),
                    MemoryContext("another-owner", BUSINESS, "investigador")):
        foreign = MemoryRecall(writer).retrieve(context, PRIORITY_QUERY)
        assert not foreign["knowledge"] and not foreign["experiences"] and not foreign["refs"]


def test_nonmatching_personal_experience_is_not_forced_ahead_of_relevant_business_knowledge(tmp_path):
    writer, _personal, general = competing_role_memory(tmp_path)
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "uncertainty", max_chars=6000)
    assert result["knowledge"] == [general["payload"]] and not result["experiences"]
    assert result["versions"] == {general["record_id"]: general["revision"]}
    assert result["refs"] == ["source-research"]


def test_expired_personal_experience_does_not_displace_current_shared_knowledge(tmp_path):
    writer, personal, general = competing_role_memory(tmp_path, valid_until="2026-11-23T00:00:00Z")
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), PRIORITY_QUERY,
                                          at="2026-11-23T12:00:00Z", max_chars=6000)
    assert result["knowledge"] == [general["payload"]] and not result["experiences"]
    assert {"record_id": personal["record_id"], "reason": "outside_validity"} in result["excluded"]
    assert result["versions"] == {general["record_id"]: general["revision"]}
    assert result["refs"] == ["source-research"]


def test_an_oversized_matching_personal_experience_is_omitted_honestly_without_starving_knowledge(tmp_path):
    writer, _personal, general = competing_role_memory(tmp_path)
    writer.register_source(CTX, source("specialist_result", "A large synthetic research report.",
        event_id="source-large", author={"kind": "specialist", "id": "investigador"},
        native_task_id="task-large", native_run_id="run-large"))
    large = writer.experience(CTX, experience(experience_id="experience-large", task_id="task-large", run_id="run-large",
        source_event_ids=["source-large"], method="research " + "m" * 1900, observed_result="r" * 3900,
        correction="c" * 1900, lesson="Uncertainty research method.", applicability="Uncertainty review."))
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "uncertainty", max_chars=6000)
    assert len(json.dumps(large["payload"], ensure_ascii=False)) > 6000
    assert result["knowledge"] == [general["payload"]] and not result["experiences"] and result["truncated"]
    assert result["versions"] == {general["record_id"]: general["revision"]}
    assert result["refs"] == ["source-research"]


def confirmed_catalogue_memory(tmp_path, constraint_type):
    writer = MemoryWriter(Ledger(tmp_path / "ledger.db"), InMemoryStore())
    writer.register_source(CTX, source("specialist_result", "A fictional catalogue exercise.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    personal = writer.experience(CTX, sized_payload(experience(
        method="Check the selected fictional item.", observed_result="A fictional catalogue check finished. ",
        correction="Retain the selected fictional item.",
        lesson="A fictional teammate can be misled without a catalogue check.",
        applicability="Fictional catalogue reviews."), "observed_result", 1991))
    fields = [
        ("Offer", "price", "offer-a", "10", 824),
        ("Offer", "price", "offer-b", "20", 839),
        ("Offer", "price", "offer-c", "30", 882),
        ("Business", "voice_notes", "business", "Plain fixture tone.", 792),
        ("Business", "positioning", "business", "A clearly described fixture.", 1136),
    ]
    facts = []
    for index, (entity, field, subject, value, chars) in enumerate(fields):
        event_id = f"fact-{index}"
        item = sized_payload(candidate(event_id, f"CatalogueFactSentinel fixture entry {index}. ",
            entity_type=entity, attributes={"field": field, "subject_ref": subject, "value": value},
            source_event_ids=[event_id]), "content", chars)
        writer.register_source(CTX, source(text=item["content"], event_id=event_id))
        facts.append(writer.candidate(CTX, item))
    boundary = sized_payload(candidate("real-boundary", "Require approval before fictional campaign activation. ",
        entity_type=constraint_type, attributes={}, source_event_ids=["boundary-source"]), "content", 800)
    writer.register_source(CTX, source(text=boundary["content"], event_id="boundary-source"))
    constraint = writer.candidate(CTX, boundary)
    return writer, personal, facts, constraint


@pytest.mark.parametrize("constraint_type", ["Decision", "OperationalConstraint"])
def test_confirmed_declared_catalogue_facts_do_not_displace_role_learning(tmp_path, constraint_type):
    writer, personal, facts, constraint = confirmed_catalogue_memory(tmp_path, constraint_type)
    assert sum(len(json.dumps(row["payload"], ensure_ascii=False)) for row in facts) == 4473
    assert len(json.dumps(personal["payload"], ensure_ascii=False)) == 1991
    recall, context = MemoryRecall(writer), replace(CTX, actor_role="investigador")
    result = recall.retrieve(context, "misled", max_chars=6000)
    assert result["experiences"] == [personal["payload"]]
    assert result["knowledge"] == [constraint["payload"]]
    assert result["size_chars"] == 2791 and not result["truncated"]
    assert result["versions"] == {row["record_id"]: row["revision"] for row in (constraint, personal)}
    assert result["refs"] == ["boundary-source", "source-1"]

    catalogue = recall.retrieve(context, "CatalogueFactSentinel", max_chars=6000)
    included = [constraint, *facts]
    assert {entry["candidate_id"] for entry in catalogue["knowledge"]} == {
        row["payload"]["candidate_id"] for row in included
    }
    assert not catalogue["experiences"] and not catalogue["truncated"]
    assert catalogue["size_chars"] == 5273
    assert catalogue["versions"] == {row["record_id"]: row["revision"] for row in included}
    assert catalogue["refs"] == sorted(ref for row in included for ref in row["payload"]["source_event_ids"])
    for row in facts:
        assert row["payload"]["validation_state"] == "confirmed" and row["provenance"] == "owner_said"
        assert writer.get(CTX, row["record_id"]) == row

    for role in ("ale", "estratega"):
        other = recall.retrieve(replace(CTX, actor_role=role), "misled", max_chars=6000)
        assert not other["experiences"] and other["knowledge"] == [constraint["payload"]]
        assert other["versions"] == {constraint["record_id"]: constraint["revision"]}
        assert other["refs"] == ["boundary-source"]
    for foreign in (replace(context, business_id=OTHER), replace(context, owner_id="another-owner")):
        hidden = recall.retrieve(foreign, "misled", max_chars=6000)
        assert not hidden["knowledge"] and not hidden["experiences"] and not hidden["refs"]


@pytest.mark.parametrize("constraint_type", ["Decision", "OperationalConstraint"])
def test_confirmed_spanish_constraint_survives_english_query_and_tight_budget(tmp_path, constraint_type):
    writer = ready(tmp_path)
    statement = "No actives una campaña sin mi aprobación."
    writer.register_source(CTX, source(text=statement, event_id="spanish-boundary"))
    record = writer.candidate(CTX, candidate("spanish-boundary", statement, entity_type=constraint_type,
        attributes={}, source_event_ids=["spanish-boundary"]))
    budget = len(json.dumps(record["payload"], ensure_ascii=False)) + 20
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"),
        "Compare current prices.", max_chars=budget)
    assert result["knowledge"] == [record["payload"]] and not result["experiences"] and result["truncated"]
    assert result["versions"] == {record["record_id"]: record["revision"]}
    assert result["refs"] == ["spanish-boundary"]


@pytest.mark.parametrize("constraint_type", ["Decision", "OperationalConstraint"])
@pytest.mark.parametrize("state", ["proposed", "expired"])
def test_only_current_confirmed_constraints_are_included_independently_of_query(tmp_path, constraint_type, state):
    writer = ready(tmp_path)
    statement = "No actives una campaña sin mi aprobación."
    writer.register_source(CTX, source(text=statement, event_id="limited-boundary"))
    options = {"epistemic": "inferred", "validation_state": "proposed"} if state == "proposed" else {
        "valid_until": "2026-11-23T00:00:00Z"
    }
    record = writer.candidate(CTX, candidate("limited-boundary", statement, entity_type=constraint_type,
        attributes={}, source_event_ids=["limited-boundary"], **options))
    personal = writer.get(CTX, "experience-1")
    result = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "Compare current prices.",
        at="2026-11-23T12:00:00Z", max_chars=6000)
    assert result["experiences"] == [personal["payload"]] and not result["knowledge"]
    assert result["versions"] == {personal["record_id"]: personal["revision"]}
    assert result["refs"] == ["source-1"]
    if state == "expired":
        assert {"record_id": record["record_id"], "reason": "outside_validity"} in result["excluded"]
