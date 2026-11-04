import fcntl
import hashlib
import json
import multiprocessing
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from test_knowledge import CTX, OTHER, candidate, experience, source

from saleads_brain.curation import READ_PAGE_CHARS, CurationQueue
from saleads_brain.graph import InMemoryStore
from saleads_brain.knowledge import MemoryError, MemoryWriter
from saleads_brain.ledger import Ledger
from saleads_brain.settings import group_id


def ready(tmp_path):
    ledger = Ledger(tmp_path / "ledger.db")
    memory = MemoryWriter(ledger, InMemoryStore())
    return memory, CurationQueue(ledger, memory)


def running(queue, batch):
    queue.bind_native(CTX, batch["batch_id"], "task-1")
    return queue.bind_native(CTX, batch["batch_id"], "task-1", "run-1")


def _process_commit_lock(path, signal, probe):
    """Spawned fixture uses actual independent file descriptors/process IDs."""
    ledger = Ledger(path)
    if probe:
        with ledger.path.with_name(ledger.path.name + ".curation-commit.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                signal.send("blocked")
            else:
                signal.send("unexpectedly_acquired")
                fcntl.flock(lock, fcntl.LOCK_UN)
    with ledger.curation_commit_lock():
        signal.send("entered")
        signal.recv()
    signal.close()


def test_empty_or_technical_queue_never_requests_inference(tmp_path):
    memory, queue = ready(tmp_path)
    assert queue.create(CTX) is None and queue.pending(CTX) == []
    memory.register_source(CTX, source("operator_canary", "The owner said: double the budget."))
    assert queue.create(CTX) is None and queue.pending(CTX) == []
    with memory.ledger.connect() as db:
        row = db.execute("SELECT state,reason FROM curation_sources").fetchone()
    assert dict(row) == {"state": "discarded", "reason": "non_business_source"}


def test_loss_of_dispatch_ack_reuses_the_same_batch_key_and_native_task_after_restart(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = queue.create(CTX)
    assert queue.create(CTX) is None
    queue.bind_native(CTX, batch["batch_id"], "task-1")
    restarted = CurationQueue(Ledger(tmp_path / "ledger.db"), memory)
    pending = restarted.pending(CTX)
    assert len(pending) == 1 and pending[0]["idempotency_key"] == batch["idempotency_key"]
    assert pending[0]["native_task_id"] == "task-1"
    assert restarted.bind_native(CTX, batch["batch_id"], "task-1") == pending[0]


def test_repeated_commit_preserves_one_source_one_candidate_one_receipt(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    committed = queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    assert committed["state"] == "committed" and queue.pending(CTX) == []
    assert queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[]) == committed
    assert memory.get(CTX, "candidate-1")["evidence_count"] == 1
    assert queue.cursor(CTX) == 1
    with memory.ledger.connect() as db:
        row = db.execute("SELECT commit_request_sha256 FROM curation_batches WHERE batch_id=?",
                         (batch["batch_id"],)).fetchone()
    assert len(row["commit_request_sha256"]) == 64
    assert "commit_request_sha256" not in committed  # Internal receipt, no public schema drift.


def test_pending_earlier_batch_is_not_skipped_when_later_batch_finishes(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    earlier = queue.create(CTX)
    memory.register_source(CTX, source(event_id="source-2"))
    later = queue.create(CTX)
    running(queue, later)
    queue.commit(CTX, later["batch_id"], candidates=[], experiences=[], discarded_reason="No new material claim.")
    assert queue.cursor(CTX) == 0
    running(queue, earlier)
    queue.commit(CTX, earlier["batch_id"], candidates=[candidate()], experiences=[])
    assert queue.cursor(CTX) == 2


def test_batch_cannot_import_another_business_or_source_outside_its_batch(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    memory.register_source(CTX, source(event_id="later-source"))
    with pytest.raises(MemoryError, match="candidate_source_outside_batch"):
        queue.commit(CTX, batch["batch_id"], candidates=[candidate(source_event_ids=["later-source"])], experiences=[])
    with pytest.raises(MemoryError, match="curation_batch_not_found_in_business"):
        queue.read(replace(CTX, business_id=OTHER), batch["batch_id"])
    with pytest.raises(MemoryError, match="curator_profile_required"):
        queue.read(replace(CTX, actor_role="ale"), batch["batch_id"])


def test_failed_native_run_keeps_same_batch_and_sources_for_native_retry(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    queue.fail(CTX, batch["batch_id"], "native_failed")
    assert queue.create(CTX) is None
    retried = queue.bind_native(CTX, batch["batch_id"], "task-1", "run-2")
    assert retried["native_run_id"] == "run-2" and retried["state"] == "running"
    with pytest.raises(MemoryError, match="curation_native_task_conflict"):
        queue.bind_native(CTX, batch["batch_id"], "task-2", "run-2")


def read_all_pages(queue, context, batch_id):
    fragments, pages, cursor = [], [], None
    while True:
        page = queue.read_page(context, batch_id, cursor)
        assert len(json.dumps(page, ensure_ascii=True)) <= READ_PAGE_CHARS
        assert page["offset"] == sum(map(len, fragments))
        assert page["fragment"] and page["payload_sha256"] == (pages[0]["payload_sha256"] if pages else page["payload_sha256"])
        assert "sources" not in page  # Fragments never masquerade as SourceEvents.
        pages.append(page)
        fragments.append(page["fragment"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
        assert len(pages) < 1000
    document = "".join(fragments)
    assert len(document) == pages[-1]["total_chars"]
    assert hashlib.sha256(document.encode()).hexdigest() == pages[0]["payload_sha256"]
    return json.loads(document), pages


def test_large_batch_pages_preserve_every_original_source_without_spill_or_hash_churn(tmp_path):
    memory, queue = ready(tmp_path)
    for index in range(18):
        memory.register_source(CTX, source(text=f"Evidence {index}: " + "Research source. " * 720,
                                           event_id=f"source-{index}"))
    batch = running(queue, queue.create(CTX))
    first = queue.read_page(CTX, batch["batch_id"])
    assert first["total_chars"] > 204_908
    assert queue.bind_native(CTX, batch["batch_id"], "task-1", "run-1") == batch
    assert queue.read_page(CTX, batch["batch_id"]) == first  # Lost ACK / repeated RUNNING observation.
    document, pages = read_all_pages(queue, CTX, batch["batch_id"])
    assert document == queue.read(CTX, batch["batch_id"])
    assert 35 < len(pages) < 60
    assert len(document["sources"]) == 18
    assert all(hashlib.sha256(item["content"].encode()).hexdigest() == item["content_sha256"]
               for item in document["sources"])


def test_single_source_unicode_controls_and_oversized_references_all_remain_retrievable(tmp_path):
    memory, queue = ready(tmp_path)
    text = ("Investigación 🙂\n\t\x00" * 1500)[:24000]
    references = [f"https://example.test/{index}/" + "r" * 2000 for index in range(30)]
    memory.register_source(CTX, source(text=text, refs=references))
    batch = running(queue, queue.create(CTX))
    document, pages = read_all_pages(queue, CTX, batch["batch_id"])
    assert len(pages) > 20
    assert document == queue.read(CTX, batch["batch_id"])
    assert document["sources"][0]["content"] == text and document["sources"][0]["refs"] == references
    assert document["sources"][0]["source_id"] == "source-1"
    assert document["sources"][0]["source_version"] == "1"


@pytest.mark.parametrize("cursor", ["", "curation-page/1:bad:4", "curation-page/1:" + "0" * 64 + ":1",
                                    "curation-page/1:" + "0" * 64 + ":99999999999", False, 12, {}])
def test_bad_page_cursors_cannot_select_unbound_sources(tmp_path, cursor):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    with pytest.raises(MemoryError, match="invalid_curation_page_cursor"):
        queue.read_page(CTX, batch["batch_id"], cursor)
    with pytest.raises(MemoryError, match="curation_batch_not_found_in_business"):
        queue.read_page(replace(CTX, business_id=OTHER), batch["batch_id"], cursor)
    with pytest.raises(MemoryError, match="curator_profile_required"):
        queue.read_page(replace(CTX, actor_role="ale"), batch["batch_id"], cursor)


def test_page_cursor_covers_full_source_document_and_same_failed_task_new_run(tmp_path, monkeypatch):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source(text="Original evidence. " * 900))
    batch = running(queue, queue.create(CTX))
    first = queue.read_page(CTX, batch["batch_id"])
    cursor = first["next_cursor"]
    assert cursor
    with pytest.raises(MemoryError, match="invalid_curation_page_cursor"):
        queue.read_page(CTX, batch["batch_id"], f"curation-page/1:{first['payload_sha256']}:{first['total_chars']}")
    original_source = memory.source
    with monkeypatch.context() as patch:
        patch.setattr(memory, "source", lambda *args: {**original_source(*args), "refs": ["changed-source-ref"]})
        with pytest.raises(MemoryError, match="invalid_curation_page_cursor"):
            queue.read_page(CTX, batch["batch_id"], cursor)
    failed = queue.fail(CTX, batch["batch_id"], "native_curation_blocked")
    assert queue.bind_native(CTX, batch["batch_id"], "task-1", "run-1") == failed
    assert queue.batch(CTX, batch["batch_id"])["state"] == "failed"
    with pytest.raises(MemoryError, match="invalid_curation_page_cursor"):
        queue.read_page(CTX, batch["batch_id"], cursor)
    retried = queue.bind_native(CTX, batch["batch_id"], "task-1", "run-2")
    assert retried["native_task_id"] == batch["native_task_id"] and retried["state"] == "running"
    assert retried["native_run_id"] == "run-2" and retried["source_event_ids"] == batch["source_event_ids"]
    with pytest.raises(MemoryError, match="invalid_curation_page_cursor"):
        queue.read_page(CTX, batch["batch_id"], cursor)
    document, _ = read_all_pages(queue, CTX, batch["batch_id"])
    assert document["sources"] == [{key: value for key, value in original_source(CTX, "source-1").items()
                                    if not key.startswith("_")}]


def test_terminal_batch_pages_and_identical_commit_receipts_stay_readable_without_rebind(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    committed = queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    page = queue.read_page(CTX, batch["batch_id"])
    assert queue.bind_native(CTX, batch["batch_id"], "task-1", "run-2") == committed
    assert queue.fail(CTX, batch["batch_id"], "native_curation_blocked") == committed
    assert queue.read_page(CTX, batch["batch_id"]) == page
    assert json.loads(page["fragment"])["batch"] == committed
    assert queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[]) == committed
    with pytest.raises(MemoryError, match="curation_commit_payload_conflict"):
        queue.commit(CTX, batch["batch_id"], candidates=[candidate("different")], experiences=[])


def test_greeting_is_discarded_with_reason_not_fabricated_as_business_learning(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source(text="Hello."))
    batch = running(queue, queue.create(CTX))
    with pytest.raises(MemoryError, match="empty_curation_requires_reason"):
        queue.commit(CTX, batch["batch_id"], candidates=[], experiences=[])
    result = queue.commit(CTX, batch["batch_id"], candidates=[], experiences=[], discarded_reason="Greeting only.")
    assert result["state"] == "discarded" and result["discarded_reason"] == "Greeting only."
    assert memory.current(CTX) == []


def test_mixed_batch_keeps_api_provenance_and_excludes_technical_operator_quote(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source("operator_canary", "Owner quote: The price is 100.", event_id="technical"))
    memory.register_source(CTX, source("api_observation", '{"spend": 5}', event_id="actual-api"))
    batch = running(queue, queue.create(CTX))
    assert batch["source_event_ids"] == ["actual-api"]
    queue.commit(CTX, batch["batch_id"], candidates=[candidate(text="Spend is 5.", source_event_ids=["actual-api"],
        epistemic="observed", entity_type="Campaign", attributes={"subject_ref": "campaign-1", "field": "spend", "value": 5})],
        experiences=[])
    assert memory.get(CTX, "candidate-1")["provenance"] == "platform"


def test_terminal_batch_rejects_changed_candidate_or_appended_experience(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    original = queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    for changed in (
        {"candidates": [candidate("candidate-2")], "experiences": []},
        {"candidates": [candidate()], "experiences": [experience()]},
        {"candidates": [candidate(), candidate("candidate-2")], "experiences": []},
    ):
        with pytest.raises(MemoryError, match="curation_commit_payload_conflict"):
            queue.commit(CTX, batch["batch_id"], **changed)
        assert queue.batch(CTX, batch["batch_id"]) == original
    assert len(memory.current(CTX)) == 1
    assert memory.get(CTX, "candidate-1")["evidence_count"] == 1


def test_terminal_experience_and_discard_reason_are_immutable(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source("specialist_result", "A checked native research result.",
        author={"kind": "specialist", "id": "investigador"}, native_task_id="task-1", native_run_id="run-1"))
    batch = running(queue, queue.create(CTX))
    original = queue.commit(CTX, batch["batch_id"], candidates=[], experiences=[experience()])
    assert queue.commit(CTX, batch["batch_id"], candidates=[], experiences=[experience()]) == original
    with pytest.raises(MemoryError, match="curation_commit_payload_conflict"):
        queue.commit(CTX, batch["batch_id"], candidates=[], experiences=[experience(lesson="Different lesson.")])
    assert memory.get(CTX, "experience-1")["evidence_count"] == 1
    memory.register_source(CTX, source(text="Hello.", event_id="source-2"))
    discarded = running(queue, queue.create(CTX))
    result = queue.commit(CTX, discarded["batch_id"], candidates=[], experiences=[], discarded_reason="Greeting only.")
    assert queue.commit(CTX, discarded["batch_id"], candidates=[], experiences=[], discarded_reason="Greeting only.") == result
    with pytest.raises(MemoryError, match="curation_commit_payload_conflict"):
        queue.commit(CTX, discarded["batch_id"], candidates=[], experiences=[], discarded_reason="Changed reason.")


def test_failed_validation_can_repair_an_open_batch_without_claiming_a_receipt(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    with pytest.raises(MemoryError, match="candidate_source_outside_batch"):
        queue.commit(CTX, batch["batch_id"], candidates=[candidate(source_event_ids=["not-in-batch"])], experiences=[])
    assert queue.batch(CTX, batch["batch_id"])["state"] == "running"
    with memory.ledger.connect() as db:
        assert db.execute("SELECT commit_request_sha256 FROM curation_batches").fetchone()[0] is None
    assert queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])["state"] == "committed"


def test_one_invalid_candidate_rejects_the_batch_before_any_write_so_the_fixed_retry_keeps_its_ids(tmp_path):
    # E2E 4-nov: the 1st item was written, the 2nd failed with owner_quote_not_in_registered_source, and the fixed
    # retry hit candidate_idempotency_conflict on the 1st. The whole batch is validated before the first write.
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    good = candidate("candidate-1", attributes={"field": "price", "subject_ref": "offer-1", "value": "100"})
    unquoted = candidate("candidate-2", text="The owner ships worldwide.", attributes={})
    with pytest.raises(MemoryError, match="owner_quote_not_in_registered_source"):
        queue.commit(CTX, batch["batch_id"], candidates=[good, unquoted], experiences=[])
    with memory.ledger.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM memory_knowledge_aliases").fetchone()[0] == 0
    fixed = {**good, "content": "The price is 100.", "validation_state": "confirmed"}
    inferred = {**unquoted, "epistemic": "inferred", "validation_state": "proposed"}
    assert queue.commit(CTX, batch["batch_id"], candidates=[fixed, inferred], experiences=[])["state"] == "committed"


def test_legacy_terminal_receipt_stays_readable_without_inventing_its_request(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    original = queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    # Physical v5 shape, including the historical terminal receipt/data.
    with memory.ledger.transaction() as db:
        before = db.execute("SELECT payload_json FROM curation_batches").fetchone()[0]
        db.execute("ALTER TABLE curation_batches DROP COLUMN commit_request_sha256")
        db.execute("DELETE FROM schema_migrations WHERE version=6")
    migrated = Ledger(memory.ledger.path)
    restarted = CurationQueue(migrated, memory)
    assert migrated.schema_versions() == [1, 2, 3, 4, 5, 6]
    assert restarted.read(CTX, batch["batch_id"])["batch"] == original
    for body in ([candidate()], [candidate("different")]):
        with pytest.raises(MemoryError, match="curation_commit_receipt_unverifiable"):
            restarted.commit(CTX, batch["batch_id"], candidates=body, experiences=[])
    with migrated.connect() as db:
        row = db.execute("SELECT payload_json,commit_request_sha256 FROM curation_batches").fetchone()
    assert row["payload_json"] == before and row["commit_request_sha256"] is None
    assert memory.get(CTX, "candidate-1")["evidence_count"] == 1


@pytest.mark.parametrize("different", [False, True])
def test_concurrent_finalizers_use_one_receipt_without_writing_the_loser(tmp_path, different):
    entered, release = threading.Event(), threading.Event()
    calls = []
    class SlowWriter(MemoryWriter):
        def candidate(self, context, item):
            calls.append("first")
            entered.set()
            assert release.wait(5)
            return super().candidate(context, item)
    class OtherWriter(MemoryWriter):
        def candidate(self, context, item):
            calls.append("second")
            return super().candidate(context, item)
    ledger = Ledger(tmp_path / "ledger.db")
    memory = SlowWriter(ledger, InMemoryStore())
    queue = CurationQueue(ledger, memory)
    other = CurationQueue(Ledger(ledger.path), OtherWriter(Ledger(ledger.path), InMemoryStore()))
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(queue.commit, CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
        try:
            assert entered.wait(5)
            # OS critical section is really held during the individual writes,
            # across separate file descriptors/Ledger instances, not only at the final UPDATE.
            with (
                (ledger.path.parent / (ledger.path.name + ".curation-commit.lock")).open("a") as lock,
                pytest.raises(BlockingIOError),
            ):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            second = pool.submit(other.commit, CTX, batch["batch_id"],
                                 candidates=[candidate("different") if different else candidate()], experiences=[])
        finally:
            release.set()
        result = first.result(timeout=5)
        if different:
            with pytest.raises(MemoryError, match="curation_commit_payload_conflict"):
                second.result(timeout=5)
        else:
            assert second.result(timeout=5) == result
    assert calls == ["first"]
    assert len(memory.current(CTX)) == 1 and memory.get(CTX, "candidate-1")["evidence_count"] == 1


@pytest.mark.parametrize("terminate", [False, True])
def test_os_critical_section_blocks_another_process_and_releases_after_owner_exit(tmp_path, terminate):
    ledger = Ledger(tmp_path / "ledger.db")
    context = multiprocessing.get_context("spawn")
    owner_signal, owner_child = context.Pipe()
    other_signal, other_child = context.Pipe()
    owner = context.Process(target=_process_commit_lock, args=(ledger.path, owner_child, False), daemon=True)
    other = context.Process(target=_process_commit_lock, args=(ledger.path, other_child, True), daemon=True)
    try:
        owner.start()
        assert owner_signal.poll(5) and owner_signal.recv() == "entered"
        other.start()
        assert other_signal.poll(5) and other_signal.recv() == "blocked"
        # The nonblocking OS probe above proves exclusion without relying on a sleep.
        if terminate:
            owner.terminate()  # No Python finally: the kernel must release the handle.
        else:
            owner_signal.send("release")
        owner.join(timeout=5)
        assert not owner.is_alive()
        assert (owner.exitcode != 0) if terminate else (owner.exitcode == 0)
        assert other_signal.poll(5) and other_signal.recv() == "entered"
        other_signal.send("release")
        other.join(timeout=5)
        assert not other.is_alive() and other.exitcode == 0
    finally:
        for process in (owner, other):
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=5)
        for signal in (owner_signal, owner_child, other_signal, other_child):
            signal.close()


def test_projection_failure_replays_partial_record_without_evidence_reinforcement(tmp_path):
    class FailOnceStore(InMemoryStore):
        fail = True
        def upsert_node(self, group, node):
            if self.fail:
                self.fail = False
                raise RuntimeError("synthetic_projection_failure")
            return super().upsert_node(group, node)
    store = FailOnceStore()
    memory = MemoryWriter(Ledger(tmp_path / "ledger.db"), store)
    queue = CurationQueue(memory.ledger, memory)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    with pytest.raises(RuntimeError, match="synthetic_projection_failure"):
        queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    assert queue.batch(CTX, batch["batch_id"])["state"] == "running"
    record = memory.get(CTX, "candidate-1")
    assert record["projection_status"] == "pending" and record["evidence_count"] == 1
    with memory.ledger.connect() as db:
        assert db.execute("SELECT commit_request_sha256 FROM curation_batches").fetchone()[0] is None
    committed = queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    assert committed["committed_ids"] == [record["record_id"]]
    assert queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[]) == committed
    assert memory.get(CTX, "candidate-1")["evidence_count"] == 1
    assert sorted(node.type_name for node in store.nodes(group_id(CTX.business_id), 100)) == ["Evidence", "Offer"]


def test_commit_never_discloses_or_changes_a_foreign_batch(tmp_path):
    memory, queue = ready(tmp_path)
    memory.register_source(CTX, source())
    batch = running(queue, queue.create(CTX))
    original = queue.commit(CTX, batch["batch_id"], candidates=[candidate()], experiences=[])
    for foreign in (replace(CTX, business_id=OTHER), replace(CTX, owner_id="foreign-owner")):
        with pytest.raises(MemoryError, match="curation_batch_not_found_in_business"):
            queue.commit(foreign, batch["batch_id"], candidates=[candidate("different")], experiences=[])
    assert queue.batch(CTX, batch["batch_id"]) == original
