import json
from dataclasses import replace

import pytest
from test_continuous_server import client_for, headers, managed
from test_knowledge import BUSINESS, CTX, OTHER, candidate, experience, goal, source

from saleads_brain.curation import CurationQueue
from saleads_brain.knowledge import MemoryContext, MemoryError, MemoryWriter
from saleads_brain.recall import MemoryRecall
from saleads_brain.source_admission import OperatorCanaryAdmission

QA_CLIENT = "00000000-0000-4000-8000-000000000023"


def policy(brain, ids=(), owner=CTX.owner_id):
    path = brain.settings.hermes_data / "saleads/continuous/operator-canary-client-ids.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema_version": "operator-canary-clients/1", "owner_id": owner,
                               "client_message_ids": list(ids)}))
    return path


def ready(tmp_path):
    brain = managed(tmp_path)
    path = policy(brain)
    writer = MemoryWriter(brain.ledger, brain.store, OperatorCanaryAdmission(path, CTX.owner_id))
    return brain, writer, CurationQueue(brain.ledger, writer)


def test_late_operator_policy_removes_pending_owner_context_without_retagging_source(tmp_path):
    brain = managed(tmp_path)
    policy(brain)
    event = source(event_id="qa-before-policy", source_id=QA_CLIENT)
    with client_for(brain) as client:
        assert client.post("/continuous/sources", json=event, headers=headers("collector")).status_code == 200
        request = {"business_id": BUSINESS, "query": "current price"}
        before = client.post("/continuous/context", json=request, headers=headers("ale")).json()
        assert event["event_id"] in before["refs"]
        policy(brain, [QA_CLIENT])
        after = client.post("/continuous/context", json=request, headers=headers("ale")).json()
        assert event["event_id"] not in after["refs"]
    writer = MemoryWriter(brain.ledger, brain.store)
    original = writer.source(CTX, event["event_id"])
    assert {key: original[key] for key in event} == event


def test_late_policy_blocks_new_claims_and_current_recall_but_preserves_history_and_aliases(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    event = source(event_id="qa-before-policy", source_id=QA_CLIENT)
    writer.register_source(CTX, event, aliases=("legacy-qa-alias",))
    record = writer.candidate(CTX, candidate(source_event_ids=[event["event_id"]]))
    policy(brain, [QA_CLIENT])
    with pytest.raises(MemoryError, match="non_business_source_not_admissible"):
        writer.candidate(CTX, candidate("later-claim", source_event_ids=["legacy-qa-alias"]))
    assert writer.current(CTX) == []
    assert MemoryRecall(writer).retrieve(replace(CTX, actor_role="ale"), "price")["knowledge"] == []
    assert writer.get(CTX, record["record_id"]) == record
    assert writer.source(CTX, "legacy-qa-alias")["source_kind"] == "owner_message"
    assert writer.source(CTX, event["event_id"])["purpose"] == "business_work"
    assert MemoryWriter(brain.ledger, brain.store).current(CTX)  # Legacy constructor remains compatible.


def test_team_summary_metadata_filter_never_reads_private_specialist_source_payload_as_ale(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source("specialist_result", "Private research transcript.", event_id="private-result",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    writer.register_source(CTX, source(event_id="qa-owner", source_id=QA_CLIENT))
    writer.experience(CTX, experience(source_event_ids=["private-result"]))
    writer.experience(CTX, experience(experience_id="qa-experience", lesson="A QA-only price comparison lesson.",
        source_event_ids=["private-result", "qa-owner"]))
    writer.candidate(CTX, candidate("good-summary", "Verify current prices against original evidence.",
        entity_type="Research", attributes={}, epistemic="inferred", validation_state="proposed",
        source_event_ids=["private-result"]))
    writer.candidate(CTX, candidate("qa-summary", "A QA-only price comparison conclusion.",
        entity_type="Research", attributes={}, epistemic="inferred", validation_state="proposed",
        source_event_ids=["private-result", "qa-owner"]))
    policy(brain, [QA_CLIENT])
    ale = replace(CTX, actor_role="ale")
    with pytest.raises(MemoryError, match="private_source_role_mismatch"):
        writer.source(ale, "private-result")
    pack = MemoryRecall(writer).retrieve(ale, "price original evidence")
    assert [item["candidate_id"] for item in pack["knowledge"]] == ["good-summary"]
    assert "Private research transcript" not in json.dumps(pack)
    specialist_pack = MemoryRecall(writer).retrieve(replace(CTX, actor_role="investigador"), "Compare current prices.")
    assert all(item["experience_id"] != "qa-experience" for item in specialist_pack["experiences"])
    assert writer.get(CTX, "qa-experience")["payload"]["source_event_ids"] == ["private-result", "qa-owner"]
    assert writer.get(CTX, "qa-summary")["payload"]["source_event_ids"] == ["private-result", "qa-owner"]


def test_policy_does_not_exclude_api_specialist_or_authentic_owner_sources_by_text_or_account(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    policy(brain, [QA_CLIENT])
    events = [source("api_observation", event_id="real-api", source_id=QA_CLIENT),
        source("specialist_result", event_id="real-specialist", source_id=QA_CLIENT,
               author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"),
        source(text="Automated QA test is only quoted here by a genuine owner.", event_id="real-owner",
               source_id="00000000-0000-4000-8000-000000000024")]
    for event in events:
        writer.register_source(CTX, event)
        assert writer.source_exclusions(CTX, [event["event_id"]]) == []
    writer.experience(CTX, experience(source_event_ids=["real-specialist"]))
    writer.candidate(CTX, candidate(source_event_ids=["real-owner"],
        text=events[-1]["content"], entity_type="Decision", attributes={}))
    assert writer.current(CTX)


def test_fresh_authentic_claim_never_merges_back_into_an_excluded_qa_record(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="qa-source", source_id=QA_CLIENT))
    previous = writer.candidate(CTX, candidate("qa-claim", source_event_ids=["qa-source"]))
    policy(brain, [QA_CLIENT])
    writer.register_source(CTX, source(event_id="authentic-answer"))
    fresh = writer.candidate(CTX, candidate("authentic-claim", source_event_ids=["authentic-answer"]))
    assert fresh["record_id"] != previous["record_id"]
    assert fresh["revision"] == previous["revision"] + 1
    assert writer.get(CTX, previous["record_id"]) == previous
    assert writer.current(CTX) == [fresh]


def test_excluded_newer_record_does_not_consume_the_current_memory_limit(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="genuine-source"))
    genuine = writer.candidate(CTX, candidate("genuine-claim", source_event_ids=["genuine-source"]))
    writer.register_source(CTX, source("owner_message", "The new price is 200.",
        event_id="qa-source", source_id=QA_CLIENT))
    writer.candidate(CTX, candidate("qa-claim", "The new price is 200.",
        attributes={"field": "price", "subject_ref": "other-offer", "value": "200"}, source_event_ids=["qa-source"]))
    policy(brain, [QA_CLIENT])
    assert writer.current(CTX, limit=1) == [genuine]


def test_policy_and_reference_resolution_are_owner_and_business_scoped(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    policy(brain, [QA_CLIENT])
    writer.register_source(CTX, source(event_id="owner-a-qa", source_id=QA_CLIENT))
    with pytest.raises(MemoryError, match="source_not_found_in_business"):
        writer.source_exclusions(replace(CTX, business_id=OTHER), ["owner-a-qa"])
    other = MemoryContext("another-owner", BUSINESS)
    writer.register_source(other, source(event_id="owner-b-source", source_id=QA_CLIENT, owner_id=other.owner_id,
        author={"kind": "owner", "id": other.owner_id}))
    assert writer.source_exclusions(other, ["owner-b-source"])[0]["reason"] == "source_policy_unavailable"
    other_path = tmp_path / "other-owner/operator-canary-client-ids.json"
    other_path.parent.mkdir()
    other_path.write_text(json.dumps({"schema_version": "operator-canary-clients/1", "owner_id": other.owner_id,
                                     "client_message_ids": []}))
    other_writer = MemoryWriter(brain.ledger, brain.store, OperatorCanaryAdmission(other_path, other.owner_id))
    assert other_writer.source_exclusions(other, ["owner-b-source"]) == []
    with pytest.raises(MemoryError, match="source_not_found_in_business"):
        other_writer.source_exclusions(other, ["owner-a-qa"])


@pytest.mark.parametrize("invalid", ["missing", "owner", "schema", "uuid", "symlink"])
def test_invalid_policy_fails_closed_for_owner_admission_without_blocking_api(tmp_path, invalid):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="owner-source", source_id=QA_CLIENT))
    writer.register_source(CTX, source("api_observation", event_id="api-source"))
    path = policy(brain)
    assert writer.source_exclusions(CTX, ["owner-source"]) == []
    if invalid == "missing":
        path.unlink()
    elif invalid == "owner":
        policy(brain, [QA_CLIENT], owner="another-owner")
    elif invalid == "schema":
        path.write_text('{"schema_version":"unknown"}')
    elif invalid == "uuid":
        policy(brain, ["not-a-client-uuid"])
    else:
        target = path.with_suffix(".fixture")
        path.rename(target)
        path.symlink_to(target)
    assert writer.source_exclusions(CTX, ["owner-source"])[0]["reason"] == "source_policy_unavailable"
    assert writer.source_exclusions(CTX, ["api-source"]) == []
    with pytest.raises(MemoryError, match="non_business_source_not_admissible"):
        writer.candidate(CTX, candidate(source_event_ids=["owner-source"]))


def test_existing_curation_batch_preserves_originals_and_reports_late_exclusion_before_commit(tmp_path):
    brain, writer, queue = ready(tmp_path)
    event = source(event_id="qa-pending", source_id=QA_CLIENT)
    writer.register_source(CTX, event)
    batch = queue.create(CTX)
    assert batch is not None
    queue.bind_native(CTX, batch["batch_id"], "task-1", "run-1")
    policy(brain, [QA_CLIENT])
    read = queue.read(CTX, batch["batch_id"])
    assert read["sources"] == [event]
    assert read["exclusions"] == [{"event_id": event["event_id"], "reason": "operator_canary"}]
    with pytest.raises(MemoryError, match="non_business_source_not_admissible"):
        queue.commit(CTX, batch["batch_id"], candidates=[candidate(source_event_ids=[event["event_id"]])], experiences=[])
    discarded = queue.commit(CTX, batch["batch_id"], candidates=[], experiences=[],
        discarded_reason="All sources are operator QA under the current policy.")
    assert discarded["state"] == "discarded"
    assert queue.read(CTX, batch["batch_id"])["sources"] == [event]


def test_new_batches_skip_late_qa_and_pending_owner_limit_still_finds_authentic_input(tmp_path):
    brain, writer, queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="genuine-earlier-owner"))
    ids = [f"00000000-0000-4000-8000-{index:012d}" for index in range(5)]
    for index, client in enumerate(ids):
        writer.register_source(CTX, source(event_id=f"qa-{index}", source_id=client))
    policy(brain, ids)
    assert [s["event_id"] for s in queue.pending_owner_sources(CTX)] == ["genuine-earlier-owner"]
    assert queue.pending_source_count(CTX) == 1
    assert queue.create(CTX)["source_event_ids"] == ["genuine-earlier-owner"]
    with brain.ledger.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM curation_sources WHERE state='discarded'").fetchone()[0] == 5


def test_goal_can_only_explicitly_drop_policy_known_qa_into_a_proposal_without_rewriting_history(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="qa-owner", source_id=QA_CLIENT))
    writer.register_source(CTX, source("api_observation", event_id="api-context"))
    previous = writer.put_goal(CTX, goal(origin="owner_confirmed", source_event_ids=["api-context", "qa-owner"]))
    with client_for(brain) as client:
        policy(brain, [QA_CLIENT])
        pack = client.post("/continuous/context", json={"business_id": BUSINESS, "query": "current goal"},
            headers=headers("ale")).json()
        assert pack["goal"] is None and "qa-owner" not in pack["refs"]
        for fields in ({"state": "active"}, {"origin": "owner_confirmed", "state": "active"}):
            denied = client.post("/continuous/goals", json={"operation": "upsert", **fields}, headers=headers("ale"))
            assert denied.status_code == 400 and denied.json()["reason"] == "non_business_source_not_admissible"
        assert client.post("/continuous/goals", json={"operation": "get"}, headers=headers("ale")).json()["goal"] == previous
        response = client.post("/continuous/goals", json={"operation": "upsert", "origin": "assistant_proposed"},
            headers=headers("ale"))
        assert response.status_code == 200, response.json()
        updated = response.json()["goal"]
        assert updated["origin"] == "assistant_proposed" and updated["mandate"] == previous["mandate"]
        assert "api-context" in updated["source_event_ids"] and "qa-owner" not in updated["source_event_ids"]
        assert response.json()["exclusions"] == [{"event_id": "qa-owner", "reason": "operator_canary"}]
        assert client.post("/continuous/goals", json={"operation": "upsert", "origin": "owner_confirmed"},
            headers=headers("ale")).json()["reason"] == "goal_confirmation_requires_current_owner_answer"
        genuine = source(event_id="genuine-answer", source_id="00000000-0000-4000-8000-000000000024",
            refs=["hermes-session:fixture-session"])
        assert client.post("/continuous/sources", json=genuine, headers=headers("collector")).status_code == 200
        confirmed = client.post("/continuous/goals", json={"operation": "upsert", "origin": "owner_confirmed",
            "source_event_ids": [genuine["event_id"]]}, headers=headers("ale"))
        assert confirmed.status_code == 200 and confirmed.json()["goal"]["origin"] == "owner_confirmed"
    with brain.ledger.connect() as db:
        original = json.loads(db.execute("SELECT payload_json FROM memory_goals WHERE revision=1").fetchone()[0])
    assert original == previous
    assert writer.source(CTX, "qa-owner")["source_kind"] == "owner_message"


@pytest.mark.parametrize("bad", ["missing", "private", "technical"])
def test_explicit_goal_remedy_never_removes_missing_private_or_other_technical_references(tmp_path, bad):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="qa-owner", source_id=QA_CLIENT))
    writer.register_source(CTX, source("api_observation", event_id="api-context"))
    previous = writer.put_goal(CTX, goal(origin="owner_confirmed", source_event_ids=["api-context", "qa-owner"]))
    if bad != "missing":
        writer.register_source(CTX, source("specialist_result" if bad == "private" else "server_instruction",
            event_id="inadmissible-ref", author={"kind": "specialist" if bad == "private" else "server",
                                               "id": "investigador"},
            native_task_id="task-1", native_run_id="run-1"))
    # A synthetic legacy record with an invalid reference must not be silently cleaned.
    legacy = {**previous, "source_event_ids": [*previous["source_event_ids"], "inadmissible-ref"]}
    with brain.ledger.transaction() as db:
        db.execute("UPDATE memory_goals SET payload_json=?", (json.dumps(legacy),))
    policy(brain, [QA_CLIENT])
    with client_for(brain) as client:
        denied = client.post("/continuous/goals", json={"operation": "upsert", "origin": "assistant_proposed"},
            headers=headers("ale"))
        assert denied.status_code == 400
        assert denied.json()["reason"] == {"missing": "source_not_found_in_business",
            "private": "private_source_role_mismatch", "technical": "non_business_source_not_admissible"}[bad]
        assert client.post("/continuous/goals", json={"operation": "get"}, headers=headers("ale")).json()["goal"] == legacy


def test_goal_remedy_cannot_remove_owner_references_under_an_unverifiable_policy(tmp_path):
    brain, writer, _queue = ready(tmp_path)
    writer.register_source(CTX, source(event_id="genuine-owner", source_id=QA_CLIENT))
    previous = writer.put_goal(CTX, goal(origin="owner_confirmed", source_event_ids=["genuine-owner"]))
    policy(brain, [QA_CLIENT], owner="another-owner")
    with client_for(brain) as client:
        denied = client.post("/continuous/goals", json={"operation": "upsert", "origin": "assistant_proposed"},
            headers=headers("ale"))
        assert denied.status_code == 400 and denied.json()["reason"] == "non_business_source_not_admissible"
        assert client.post("/continuous/goals", json={"operation": "get"}, headers=headers("ale")).json()["goal"] == previous
