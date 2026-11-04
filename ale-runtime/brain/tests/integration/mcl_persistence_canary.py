"""Real FalkorDB + SQLite managed-memory canary, synthetic namespaces only.

Run inside the remote Brain runtime image against a disposable FalkorDB service.
This is a persistence/auth contract gate, not real owner learning or inference.
Cleanup deletes only the two fresh random graphs allocated by this invocation.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sqlite3
import tempfile
import uuid
from base64 import urlsafe_b64encode
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from starlette.testclient import TestClient

from saleads_brain.app import Brain
from saleads_brain.continuous_server import CONTEXT_HEADER, PROOF_HEADER, TOKEN_HEADER, profile_token
from saleads_brain.curation import CurationQueue
from saleads_brain.graph import FalkorStore, Node
from saleads_brain.knowledge import MemoryContext, MemoryError, MemoryWriter
from saleads_brain.ledger import _DDL, _V2_COLUMNS, _V3_DDL, SCHEMA_VERSION, Ledger
from saleads_brain.recall import MemoryRecall
from saleads_brain.server import create_server
from saleads_brain.settings import group_id, load

WHEN = datetime.now(UTC).isoformat()


def source(context: MemoryContext, identity: str, text: str, *, kind: str = "api_observation",
           role: str | None = None) -> dict[str, Any]:
    author = {"api_observation": "api", "owner_message": "owner", "specialist_result": "specialist"}[kind]
    return {
        "schema_version": "source-event/1", "event_id": identity,
        "owner_id": context.owner_id, "business_id": context.business_id,
        "source_kind": kind, "source_id": identity, "source_version": "1",
        "author": {"kind": author, "id": context.owner_id if author == "owner" else role or "synthetic-api"},
        "extractor_id": None, "occurred_at": WHEN, "recorded_at": WHEN, "content": text,
        "content_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "refs": ["hermes-session:synthetic-session"] if author == "owner" else ["synthetic-source:" + identity],
        "purpose": "business_work", "native_task_id": "task-research" if role else None,
        "native_run_id": "run-research" if role else None,
    }


def candidate(context: MemoryContext, identity: str, text: str, source_id: str, *, value: str = "100") -> dict[str, Any]:
    return {
        "schema_version": "knowledge-candidate/1", "candidate_id": identity,
        "owner_id": context.owner_id, "business_id": context.business_id,
        "entity_type": "Offer", "content": text,
        "attributes": {"subject_ref": "synthetic-offer", "field": "price", "value": value},
        "source_event_ids": [source_id], "scope": "business", "specialist_role": None,
        "extractor_id": "curador", "epistemic": "declared", "validation_state": "confirmed",
        "valid_from": WHEN, "valid_until": None, "supersedes_id": None, "contradicts_id": None,
    }


def experience(context: MemoryContext) -> dict[str, Any]:
    return {
        "schema_version": "specialist-experience/1", "experience_id": "synthetic-experience",
        "owner_id": context.owner_id, "business_id": context.business_id,
        "specialist_role": "investigador", "task_id": "task-research", "run_id": "run-research",
        "method": "Compare the current source date before using a price summary.",
        "observed_result": "The synthetic cached page used an expired price.",
        "correction": "Use the current original source instead.",
        "lesson": "Verify freshness of the original source before comparing prices.",
        "applicability": "Research involving cached price comparisons.",
        "source_event_ids": ["native-research-source"], "confidence": "supported",
        "valid_from": WHEN, "valid_until": None, "shared_summary": None,
    }


def rejected(action: Any, code: str) -> None:
    try:
        action()
    except MemoryError as error:
        assert code in str(error), str(error)
    else:
        raise AssertionError("Expected source/scope rejection: " + code)


class FailOneProjection:
    """Fault injection around the real store; every nonfailed call uses FalkorDB."""

    def __init__(self, store: FalkorStore) -> None:
        self.store, self.fail = store, True

    def __getattr__(self, name: str) -> Any:
        return getattr(self.store, name)

    def upsert_node(self, group: str, node: Node) -> None:
        if self.fail:
            self.fail = False
            raise RuntimeError("synthetic_projection_failure_after_sqlite_commit")
        self.store.upsert_node(group, node)


def legacy_ledger(path: Path, business: str) -> Ledger:
    """Construct a v3 database from its versioned DDL, then actually migrate it."""
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript(_DDL)
        for name, sql in _V2_COLUMNS:
            db.execute(f"ALTER TABLE knowledge_revisions ADD COLUMN {name} {sql}")
        db.executescript(_V3_DDL)
        db.executemany("INSERT INTO schema_migrations VALUES(?,?)", [(v, WHEN) for v in (1, 2, 3)])
        db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",
                   ("legacy-event", business, "business_profile", "saleads_seed", "synthetic-seed:legacy",
                    "a" * 64, WHEN, WHEN, '{"name":"Synthetic legacy business"}'))
    ledger = Ledger(path)
    assert ledger.schema_versions()[-1] == SCHEMA_VERSION
    with closing(ledger.connect()) as db:
        assert db.execute("SELECT payload_json FROM events WHERE event_id='legacy-event'").fetchone()[0] == (
            '{"name":"Synthetic legacy business"}')
    return ledger


def signed(secret: str, owner: str, business: str, role: str = "ale") -> dict[str, str]:
    token = profile_token(secret, role)
    context = {
        "schema_version": "trusted-context/1", "owner_id": owner, "business_id": business,
        "session_id": "synthetic-session", "actor_role": role, "native_task_id": None, "native_run_id": None,
        "response_locale": "pt-BR", "locale_revision": 1, "capabilities": [], "mandate_id": None,
        "pending_context": False,
    }
    encoded = urlsafe_b64encode(json.dumps(context, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
    return {TOKEN_HEADER: token, CONTEXT_HEADER: encoded,
            PROOF_HEADER: hmac.new(token.encode(), encoded.encode(), hashlib.sha256).hexdigest()}


def seed(businesses: list[str]) -> dict[str, Any]:
    return {"schema": "saleads-seed/1", "generated_at": WHEN, "businesses": [
        {"schema_version": "saleads-business-bootstrap/1", "business_id": business, "generated_at": WHEN,
         "context": {"facts": {"business": {"name": "Synthetic canary " + str(index), "industry": "synthetic"},
                               "brand": {}, "audience": {}, "products": [], "services": [], "marketing": {}},
                     "buyer_fit": {}, "evidence": [], "unknowns": []},
         "plan": None, "campaigns": [], "business_metrics": None, "seasonal": [], "warnings": []}
        for index, business in enumerate(businesses)]}


def canary(host: str, port: int) -> dict[str, Any]:
    store = FalkorStore(host, port)
    businesses = [str(uuid.uuid4()), str(uuid.uuid4())]
    groups = [group_id(business) for business in businesses]
    # Do not allow this canary to reuse or delete a graph that existed before it.
    assert not set(groups) & set(store.groups()), "synthetic_namespace_collision"
    owner = "mcl-synthetic-owner-" + uuid.uuid4().hex
    context = MemoryContext(owner, businesses[0])
    owned: list[str] = []
    checks: list[str] = []
    try:
        for group in groups:
            owned.append(group)
            store.upsert_node(group, Node(uuid=str(uuid.uuid4()), type_name="Business", name="Synthetic canary business"))
        with tempfile.TemporaryDirectory(prefix="mcl-persistence-") as directory:
            root = Path(directory)
            ledger = legacy_ledger(root / "ledger.db", businesses[0])
            memory = MemoryWriter(ledger, store)
            checks.append("v3_to_current_sqlite_migration_preserves_history")
            # No owner source or manual trigger exists when the proposed discovery starts.
            api = source(context, "synthetic-bootstrap", '{"business_name":"Synthetic canary","price":100}')
            memory.register_source(context, api)
            proposed = {"schema_version": "goal-state/1", "goal_id": "synthetic-goal", "owner_id": owner,
                "business_id": businesses[0], "origin": "assistant_proposed",
                "mandate": "Prepare a useful initial read-only business analysis.",
                "source_event_ids": [api["event_id"]], "native_task_ids": [], "state": "active", "blockers": [],
                "next_condition": None, "next_review_at": None, "result_summary": None, "revision": 1, "updated_at": WHEN}
            assert memory.goal(context) is None
            assert memory.put_goal(context, proposed)["origin"] == "assistant_proposed"
            checks.append("assistant_proposed_goal_without_owner_trigger")

            original = source(context, "owner-price", "The price is 100.", kind="owner_message")
            memory.register_source(context, original, aliases=("legacy-owner-price",))
            item = candidate(context, "offer-price", original["content"], original["event_id"])
            first = memory.candidate(context, item)
            alias = memory.candidate(context, {**item, "candidate_id": "alias-price", "source_event_ids": ["legacy-owner-price"]})
            assert first["record_id"] == alias["record_id"] and alias["evidence_count"] == 1
            nodes_before = {n.uuid for n in store.nodes(groups[0], 200)}
            edges_before = len(store.edges(groups[0], 300))
            assert store.node(groups[0], str(uuid.UUID(first["record_id"]))) is not None
            assert any(edge.name == "EVIDENCED_BY" for edge in store.edges_of(groups[0], str(uuid.UUID(first["record_id"]))))
            assert memory.candidate(context, item)["evidence_count"] == 1
            assert {n.uuid for n in store.nodes(groups[0], 200)} == nodes_before
            assert len(store.edges(groups[0], 300)) == edges_before
            checks.append("real_graph_nodes_edges_and_source_dedupe")

            correction_source = source(context, "owner-price-correction", "The price is now 120.", kind="owner_message")
            memory.register_source(context, correction_source)
            correction = candidate(context, "corrected-price", correction_source["content"], correction_source["event_id"], value="120")
            correction["supersedes_id"] = first["record_id"]
            new = memory.candidate(context, correction)
            assert memory.get(context, "offer-price")["superseded_by"] == new["record_id"]
            assert memory.get(context, "corrected-price")["effective"]
            assert store.node(groups[0], str(uuid.UUID(first["record_id"]))).verification == "CONTRADICTED"
            assert store.node(groups[0], str(uuid.UUID(new["record_id"]))) is not None
            checks.append("real_graph_correction_preserves_old_revision")

            specialist = source(context, "native-research-source", "Synthetic cached page price was expired; use original freshness.",
                                kind="specialist_result", role="investigador")
            memory.register_source(context, specialist)
            learned = memory.experience(context, experience(context))
            researcher = replace(context, actor_role="investigador", actor_id="investigador")
            strategist = replace(context, actor_role="estratega", actor_id="estratega")
            assert MemoryRecall(memory).retrieve(researcher, "cached source price freshness")["experiences"]
            assert MemoryRecall(memory).retrieve(strategist, "cached source price freshness")["experiences"] == []
            rejected(lambda: memory.get(strategist, learned["record_id"]), "private_experience_role_mismatch")
            assert store.node(groups[0], str(uuid.UUID(learned["record_id"]))) is not None
            checks.append("individual_role_experience_real_graph_and_scoped_recall")

            # A real DB write fault is injected AFTER the SQLite candidate commit.
            failed_source = source(context, "projection-source", "We open on Monday.", kind="owner_message")
            memory.register_source(context, failed_source)
            pending = candidate(context, "projection-candidate", failed_source["content"], failed_source["event_id"])
            pending.update(entity_type="Decision", attributes={"decision_type": "operating_hours"})
            faulty = MemoryWriter(ledger, FailOneProjection(store))
            try:
                faulty.candidate(context, pending)
            except RuntimeError as error:
                assert str(error) == "synthetic_projection_failure_after_sqlite_commit"
            else:
                raise AssertionError("Expected graph projection fault")
            persisted = memory.get(context, pending["candidate_id"])
            assert persisted["projection_status"] == "pending"
            restarted = MemoryWriter(Ledger(root / "ledger.db"), store)
            assert restarted.reconcile(context) >= 1
            assert restarted.get(context, pending["candidate_id"])["projection_status"] == "complete"
            assert store.node(groups[0], str(uuid.UUID(persisted["record_id"]))) is not None
            assert restarted.candidate(context, pending)["record_id"] == persisted["record_id"]
            checks.append("sqlite_commit_graph_failure_reopen_and_reconcile")

            queue = CurationQueue(restarted.ledger, restarted)
            batch = queue.create(context)
            assert batch is not None
            queue.bind_native(context, batch["batch_id"], "native-curator-task", "native-curator-run")
            queue2 = CurationQueue(Ledger(root / "ledger.db"), restarted)
            assert queue2.pending(context)[0]["native_task_id"] == "native-curator-task"
            committed = queue2.commit(context, batch["batch_id"], candidates=[item], experiences=[experience(context)])
            assert committed["state"] == "committed"
            assert queue2.commit(context, batch["batch_id"], candidates=[item],
                                 experiences=[experience(context)]) == committed
            rejected(lambda: queue2.commit(context, batch["batch_id"], candidates=[item], experiences=[]),
                     "curation_commit_payload_conflict")
            with closing(ledger.connect()) as db:
                receipt = db.execute("SELECT commit_request_sha256 FROM curation_batches WHERE batch_id=?",
                                     (batch["batch_id"],)).fetchone()
            assert len(receipt["commit_request_sha256"]) == 64
            assert queue2.pending(context) == [] and queue2.cursor(context) > 0
            assert queue2.create(context) is None
            checks.append("durable_curation_batch_cursor_exact_replay_and_changed_payload_conflict")

            foreign = replace(context, business_id=businesses[1])
            rejected(lambda: restarted.source(foreign, original["event_id"]), "source_not_found_in_business")
            rejected(lambda: restarted.candidate(foreign, item), "memory_binding_mismatch")
            assert len(store.nodes(groups[1], 30)) == 1
            checks.append("cross_business_write_read_rejected_before_graph_mutation")

            hermes = root / "hermes"
            seed_path = hermes / "saleads/seed/seed.json"
            seed_path.parent.mkdir(parents=True)
            seed_path.write_text(json.dumps(seed(businesses)))
            secret = "synthetic-persistence-" + uuid.uuid4().hex
            settings = load({"BRAIN_DATA": str(root / "brain"), "HERMES_DATA": str(hermes),
                "BRAIN_ALE_TOKEN": secret, "BRAIN_OWNER_ID": owner, "BRAIN_MANAGED_CURATION": "true"})
            brain = Brain(settings, store, restarted.ledger)
            assert not brain.settings.llm_enabled and brain._graphiti is None
            with TestClient(create_server(brain).streamable_http_app(), base_url="http://saleads-brain:8765") as client:
                trusted = signed(secret, owner, businesses[0])
                response = client.post("/continuous/context", headers=trusted, json={"business_id": businesses[0], "query": "price"})
                assert response.status_code == 200, response.text
                assert response.json()["business_id"] == businesses[0]
                assert response.json()["goal"]["origin"] == "assistant_proposed"
                denied = client.post("/continuous/context", headers=trusted, json={"business_id": businesses[1]})
                assert denied.status_code == 400 and denied.json()["reason"] == "memory_binding_mismatch"
                static = {TOKEN_HEADER: profile_token(secret, "ale")}
                denied = client.post("/continuous/context", headers=static, json={"business_id": businesses[0]})
                assert denied.status_code == 400 and denied.json()["reason"] == "trusted_context_required"
                # This second business has no owner-message source: the real bound
                # route must still admit an API/seed-grounded proposed discovery.
                initiated = client.post("/continuous/goals", headers=signed(secret, owner, businesses[1]),
                    json={"operation": "upsert", "origin": "assistant_proposed", "state": "active",
                          "mandate": "Prepare a contextual read-only introduction from the available business data."})
                assert initiated.status_code == 200, initiated.text
                initial_goal = initiated.json()["goal"]
                assert initial_goal["origin"] == "assistant_proposed" and initial_goal["source_event_ids"]
                assert all(restarted.source(foreign, ref)["source_kind"] == "api_observation"
                           for ref in initial_goal["source_event_ids"])
                owner_answer = source(context, "owner-goal-confirmation", proposed["mandate"], kind="owner_message")
                restarted.register_source(context, owner_answer)
                confirmed = client.post("/continuous/goals", headers=trusted, json={"operation": "upsert",
                    "origin": "owner_confirmed", "source_event_ids": [owner_answer["event_id"]],
                    "expected_revision": 1, "state": "active"})
                assert confirmed.status_code == 200, confirmed.text
                assert confirmed.json()["goal"]["origin"] == "owner_confirmed"
            checks.append("signed_http_context_isolation_and_genuine_fixture_confirmation")

            # SQLite is reopened one final time after all graph/HTTP work.
            final = MemoryWriter(Ledger(root / "ledger.db"), store)
            assert final.goal(context)["origin"] == "owner_confirmed"
            assert final.get(context, "corrected-price")["effective"]
            final_queue = CurationQueue(final.ledger, final)
            assert final_queue.pending_source_count(context) > 0
            assert final_queue.create(context) is not None and final_queue.pending(context)
            checks.append("final_reopen_keeps_goal_knowledge_and_new_pending_sources")
    finally:
        # SDK v1.8.0 Graph.delete issues GRAPH.DELETE for this exact name only:
        # https://github.com/FalkorDB/falkordb-py/blob/v1.8.0/falkordb/graph.py
        for graph in owned:
            if graph in store.groups():
                store._db.select_graph(graph).delete()
        assert not set(groups) & set(store.groups()), "synthetic_graph_cleanup_failed"
    return {"status": "PASS", "checks": checks, "real_falkordb": True, "real_sqlite": True,
            "synthetic_graphs_removed": len(owned), "real_business_api_calls": 0, "model_calls": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=6379)
    arguments = parser.parse_args()
    print(json.dumps(canary(arguments.host, arguments.port), sort_keys=True))
