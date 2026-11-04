"""Durable curation batches/cursors. Dispatch and inference belong to Hermes."""

from __future__ import annotations

import hashlib
import json
import re
from contextlib import closing
from typing import Any

from saleads_brain.knowledge import MemoryContext, MemoryError, MemoryWriter, validate_contract
from saleads_brain.ledger import Ledger, now, stable_id

TERMINAL = {"committed", "discarded"}
READ_PAGE_CHARS = 6000
READ_PAGE_SCHEMA = "curation-read-page/1"
READ_PAGE_CURSOR = re.compile(r"^curation-page/1:([a-f0-9]{64}):([1-9][0-9]{0,9})$")


class CurationQueue:
    def __init__(self, ledger: Ledger, memory: MemoryWriter) -> None:
        self.ledger, self.memory = ledger, memory

    def create(self, context: MemoryContext, *, stream: str = "native", limit: int = 20) -> dict[str, Any] | None:
        """Coalesce only sources not already owned by a durable batch."""
        with self.ledger.transaction() as db:
            rows = db.execute(
                "SELECT s.rowid AS sequence,s.* FROM memory_sources s LEFT JOIN curation_sources c USING(event_id) "
                "WHERE s.owner_id=? AND s.business_id=? AND c.event_id IS NULL ORDER BY s.rowid LIMIT ?",
                (context.owner_id, context.business_id, max(1, min(limit, 20))),
            ).fetchall()
            admitted = []
            for row in rows:
                event = json.loads(row["payload_json"])
                if event["purpose"] != "business_work" or event["source_kind"] in {
                    "server_instruction",
                    "operator_canary",
                } or self.memory.source_exclusions(context, [event["event_id"]]):
                    db.execute(
                        "INSERT INTO curation_sources VALUES(?,NULL,'discarded',?,?)",
                        (
                            row["event_id"],
                            "non_business_source",
                            now(),
                        ),
                    )
                else:
                    admitted.append(row)
            if not admitted:
                return None
            source_ids = [str(row["event_id"]) for row in admitted]
            batch_id = "batch-" + stable_id(context.owner_id, context.business_id, stream, source_ids)
            timestamp = now()
            batch = {
                "schema_version": "curation-batch/1",
                "batch_id": batch_id,
                "owner_id": context.owner_id,
                "business_id": context.business_id,
                "source_event_ids": source_ids,
                "cursor": str(admitted[-1]["sequence"]),
                "state": "pending",
                "native_task_id": None,
                "native_run_id": None,
                "idempotency_key": "mcl-curation-" + batch_id,
                "committed_ids": [],
                "discarded_reason": None,
                "error_code": None,
                "updated_at": timestamp,
            }
            validate_contract("curation-batch", batch)
            db.execute(
                "INSERT INTO curation_batches(batch_id,owner_id,business_id,stream,payload_json,"
                "tokens,cost_usd,created_at,updated_at) VALUES(?,?,?,?,?,NULL,NULL,?,?)",
                (
                    batch_id,
                    context.owner_id,
                    context.business_id,
                    stream,
                    json.dumps(batch),
                    timestamp,
                    timestamp,
                ),
            )
            for source_id in source_ids:
                db.execute(
                    "INSERT INTO curation_sources VALUES(?,?,'pending',NULL,?)", (source_id, batch_id, timestamp)
                )
        return batch

    def batch(self, context: MemoryContext, batch_id: str) -> dict[str, Any]:
        with closing(self.ledger.connect()) as db:
            row = db.execute(
                "SELECT payload_json FROM curation_batches WHERE owner_id=? AND business_id=? AND batch_id=?",
                (context.owner_id, context.business_id, batch_id),
            ).fetchone()
        if row is None:
            raise MemoryError("curation_batch_not_found_in_business")
        return dict(json.loads(row["payload_json"]))

    def pending(self, context: MemoryContext, limit: int = 20) -> list[dict[str, Any]]:
        with closing(self.ledger.connect()) as db:
            rows = db.execute(
                "SELECT payload_json FROM curation_batches WHERE owner_id=? AND business_id=? "
                "AND json_extract(payload_json,'$.state') NOT IN ('committed','discarded') "
                "ORDER BY created_at LIMIT ?",
                (context.owner_id, context.business_id, max(1, min(limit, 100))),
            ).fetchall()
        return [batch for row in rows if (batch := json.loads(row["payload_json"]))["state"] not in TERMINAL]

    def pending_source_count(self, context: MemoryContext) -> int:
        with closing(self.ledger.connect()) as db:
            rows = db.execute(
                "SELECT s.event_id FROM memory_sources s LEFT JOIN curation_sources c USING(event_id) "
                "WHERE s.owner_id=? AND s.business_id=? AND json_extract(s.payload_json,'$.purpose')='business_work' "
                "AND json_extract(s.payload_json,'$.source_kind') NOT IN ('server_instruction','operator_canary') "
                "AND (c.state IS NULL OR c.state NOT IN ('committed','discarded'))",
                (context.owner_id, context.business_id),
            )
            return sum(not self.memory.source_exclusions(context, [str(row[0])]) for row in rows)

    def pending_owner_sources(self, context: MemoryContext, limit: int = 5) -> list[dict[str, Any]]:
        admitted = []
        with closing(self.ledger.connect()) as db:
            rows = db.execute(
                "SELECT s.payload_json FROM memory_sources s LEFT JOIN curation_sources c USING(event_id) "
                "WHERE s.owner_id=? AND s.business_id=? AND json_extract(s.payload_json,'$.purpose')='business_work' "
                "AND json_extract(s.payload_json,'$.source_kind')='owner_message' "
                "AND (c.state IS NULL OR c.state NOT IN ('committed','discarded')) ORDER BY s.rowid DESC",
                (context.owner_id, context.business_id),
            )
            for row in rows:
                event = dict(json.loads(row["payload_json"]))
                if not self.memory.source_exclusions(context, [event["event_id"]]):
                    admitted.append(event)
                if len(admitted) >= max(1, min(5, limit)):
                    break
        return admitted

    def bind_native(
        self,
        context: MemoryContext,
        batch_id: str,
        task_id: str,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Collector calls after consulting native task/run; no new dispatch on a lost ACK."""
        with self.ledger.transaction() as db:
            row = db.execute(
                "SELECT payload_json FROM curation_batches WHERE owner_id=? AND business_id=? AND batch_id=?",
                (context.owner_id, context.business_id, batch_id),
            ).fetchone()
            if row is None:
                raise MemoryError("curation_batch_not_found_in_business")
            batch = json.loads(row["payload_json"])
            if batch["state"] in TERMINAL:
                return dict(batch)
            if batch["native_task_id"] and batch["native_task_id"] != task_id:
                raise MemoryError("curation_native_task_conflict")
            if batch["native_run_id"] and run_id and batch["native_run_id"] != run_id and batch["state"] != "failed":
                raise MemoryError("curation_native_run_conflict")
            if batch["native_task_id"] == task_id and (run_id is None or batch["native_run_id"] == run_id):
                return dict(batch)
            batch.update(
                native_task_id=task_id,
                native_run_id=run_id or batch["native_run_id"],
                state="running" if run_id or batch["native_run_id"] else "dispatched",
                error_code=None,
                updated_at=now(),
            )
            validate_contract("curation-batch", batch)
            db.execute(
                "UPDATE curation_batches SET payload_json=?,updated_at=? WHERE batch_id=?",
                (json.dumps(batch), batch["updated_at"], batch_id),
            )
        return dict(batch)

    def read(self, context: MemoryContext, batch_id: str) -> dict[str, Any]:
        if context.actor_role != "curador":
            raise MemoryError("curator_profile_required")
        batch = self.batch(context, batch_id)
        return {
            "batch": batch,
            "exclusions": self.memory.source_exclusions(context, batch["source_event_ids"]),
            "sources": [
                {key: value for key, value in self.memory.source(context, ref).items() if not key.startswith("_")}
                for ref in batch["source_event_ids"]
            ],
        }

    def read_page(self, context: MemoryContext, batch_id: str, cursor: str | None = None) -> dict[str, Any]:
        """Page the unmodified source document, never cropped/fabricated SourceEvents.

        The native task/run and original batch/source identities are included in
        the document hash. Observing the same native run does not update the
        batch, so a lost response can replay this exact page without a snapshot.
        Any real document/binding change invalidates an older cursor.
        """
        original = self.read(context, batch_id)
        document = json.dumps(original, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(document.encode()).hexdigest()
        offset = 0
        if cursor is not None:
            match = READ_PAGE_CURSOR.fullmatch(cursor) if isinstance(cursor, str) else None
            if match is None or match[1] != fingerprint or int(match[2]) >= len(document):
                raise MemoryError("invalid_curation_page_cursor")
            offset = int(match[2])
        batch = original["batch"]
        binding = {
            key: batch[key] for key in ("owner_id", "business_id", "batch_id", "native_task_id", "native_run_id")
        }

        def page(end: int) -> dict[str, Any]:
            return {
                "schema_version": READ_PAGE_SCHEMA,
                "binding": binding,
                "payload_sha256": fingerprint,
                "offset": offset,
                "total_chars": len(document),
                "fragment": document[offset:end],
                "next_cursor": f"curation-page/1:{fingerprint}:{end}" if end < len(document) else None,
            }

        def fits(value: dict[str, Any]) -> bool:
            # Bound the FINAL wire representation, including Unicode/control
            # escaping and all identities, even if a caller uses ASCII JSON.
            return len(json.dumps(value, ensure_ascii=True)) <= READ_PAGE_CHARS

        maximum = min(len(document), offset + READ_PAGE_CHARS)
        complete = page(maximum)
        if fits(complete):
            return complete
        low, high = offset, maximum - 1
        while low < high:
            middle = (low + high + 1) // 2
            if fits(page(middle)):
                low = middle
            else:
                high = middle - 1
        if low == offset:
            raise MemoryError("curation_page_metadata_too_large")
        return page(low)

    def commit(
        self,
        context: MemoryContext,
        batch_id: str,
        *,
        candidates: list[dict[str, Any]],
        experiences: list[dict[str, Any]],
        discarded_reason: str | None = None,
    ) -> dict[str, Any]:
        if context.actor_role != "curador":
            raise MemoryError("curator_profile_required")
        self.batch(context, batch_id)  # Verify scope before acquiring the ledger critical section.
        if (
            not isinstance(candidates, list)
            or not isinstance(experiences, list)
            or any(not isinstance(item, dict) for item in [*candidates, *experiences])
            or discarded_reason is not None and not isinstance(discarded_reason, str)
        ):
            raise MemoryError("invalid_curation_items")
        try:
            encoded = json.dumps(
                {"candidates": candidates, "experiences": experiences, "discarded_reason": discarded_reason},
                ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
            )
        except (ValueError, TypeError) as error:
            raise MemoryError("invalid_curation_items") from error
        fingerprint = hashlib.sha256(("curation-commit-request/1\0" + encoded).encode()).hexdigest()
        # Freeze the caller's JSON while individual record/graph writes run.
        request = json.loads(encoded)
        with self.ledger.curation_commit_lock():
            return self._commit_locked(
                context, batch_id, fingerprint, request["candidates"], request["experiences"],
                request["discarded_reason"],
            )

    @staticmethod
    def _terminal_replay(batch: dict[str, Any], stored: str | None, requested: str) -> dict[str, Any]:
        if stored is None:
            raise MemoryError("curation_commit_receipt_unverifiable")
        if stored != requested:
            raise MemoryError("curation_commit_payload_conflict")
        return batch

    def _commit_locked(
        self, context: MemoryContext, batch_id: str, fingerprint: str,
        candidates: list[dict[str, Any]], experiences: list[dict[str, Any]], discarded_reason: str | None,
    ) -> dict[str, Any]:
        with closing(self.ledger.connect()) as db:
            saved = db.execute(
                "SELECT payload_json,commit_request_sha256 FROM curation_batches "
                "WHERE owner_id=? AND business_id=? AND batch_id=?",
                (context.owner_id, context.business_id, batch_id),
            ).fetchone()
        if saved is None:
            raise MemoryError("curation_batch_not_found_in_business")
        batch = dict(json.loads(saved["payload_json"]))
        if batch["state"] in TERMINAL:
            return self._terminal_replay(batch, saved["commit_request_sha256"], fingerprint)
        if batch["state"] != "running":
            raise MemoryError("curation_batch_not_running")
        if not candidates and not experiences and not (discarded_reason or "").strip():
            raise MemoryError("empty_curation_requires_reason")
        allowed = set(batch["source_event_ids"])
        for item in [*candidates, *experiences]:
            if not set(item.get("source_event_ids") or []) <= allowed:
                raise MemoryError("candidate_source_outside_batch")
        committed_ids = []
        for item in candidates:
            committed_ids.append(self.memory.candidate(context, item)["record_id"])
        for item in experiences:
            committed_ids.append(self.memory.experience(context, item)["record_id"])
        # Candidate commits may precede this receipt. Identical retry recovers
        # them after graph failure. A failed open batch may still repair its
        # request; this does not promise all-or-nothing candidate/graph writes.
        with self.ledger.transaction() as db:
            current = db.execute(
                "SELECT payload_json,stream,commit_request_sha256 FROM curation_batches "
                "WHERE owner_id=? AND business_id=? AND batch_id=?",
                (context.owner_id, context.business_id, batch_id),
            ).fetchone()
            if current is None:
                raise MemoryError("curation_batch_not_found_in_business")
            latest = json.loads(current["payload_json"])
            if latest["state"] in TERMINAL:
                return self._terminal_replay(dict(latest), current["commit_request_sha256"], fingerprint)
            latest.update(
                state="committed" if committed_ids else "discarded",
                committed_ids=sorted(set(committed_ids)),
                discarded_reason=(discarded_reason or "")[:500] or None,
                updated_at=now(),
            )
            validate_contract("curation-batch", latest)
            db.execute(
                "UPDATE curation_batches SET payload_json=?,updated_at=?,commit_request_sha256=? "
                "WHERE owner_id=? AND business_id=? AND batch_id=?",
                (json.dumps(latest), latest["updated_at"], fingerprint,
                 context.owner_id, context.business_id, batch_id),
            )
            db.execute(
                "UPDATE curation_sources SET state=?,reason=?,updated_at=? WHERE batch_id=?",
                (
                    latest["state"],
                    latest["discarded_reason"] or "batch_committed",
                    latest["updated_at"],
                    batch_id,
                ),
            )
            remaining = db.execute(
                "SELECT MIN(s.rowid) FROM memory_sources s LEFT JOIN curation_sources c USING(event_id) "
                "WHERE s.owner_id=? AND s.business_id=? "
                "AND (c.state IS NULL OR c.state NOT IN ('committed','discarded'))",
                (context.owner_id, context.business_id),
            ).fetchone()[0]
            sequence = db.execute(
                "SELECT COALESCE(MAX(s.rowid),0) FROM memory_sources s JOIN curation_sources c USING(event_id) "
                "WHERE s.owner_id=? AND s.business_id=? AND (? IS NULL OR s.rowid<?) "
                "AND c.state IN ('committed','discarded')",
                (context.owner_id, context.business_id, remaining, remaining),
            ).fetchone()[0]
            db.execute(
                "INSERT INTO curation_cursors VALUES(?,?,?,?,?) ON CONFLICT(owner_id,business_id,stream) "
                "DO UPDATE SET sequence=excluded.sequence,updated_at=excluded.updated_at",
                (context.owner_id, context.business_id, current["stream"], sequence, now()),
            )
        return dict(latest)

    def fail(self, context: MemoryContext, batch_id: str, error_code: str) -> dict[str, Any]:
        with self.ledger.transaction() as db:
            row = db.execute(
                "SELECT payload_json FROM curation_batches WHERE owner_id=? AND business_id=? AND batch_id=?",
                (context.owner_id, context.business_id, batch_id),
            ).fetchone()
            if row is None:
                raise MemoryError("curation_batch_not_found_in_business")
            batch = json.loads(row["payload_json"])
            if batch["state"] in TERMINAL:
                return dict(batch)
            batch.update(state="failed", error_code=error_code, updated_at=now())
            validate_contract("curation-batch", batch)
            db.execute(
                "UPDATE curation_batches SET payload_json=?,updated_at=? WHERE batch_id=?",
                (json.dumps(batch), batch["updated_at"], batch_id),
            )
        return dict(batch)

    def cursor(self, context: MemoryContext, stream: str = "native") -> int:
        with closing(self.ledger.connect()) as db:
            row = db.execute(
                "SELECT sequence FROM curation_cursors WHERE owner_id=? AND business_id=? AND stream=?",
                (context.owner_id, context.business_id, stream),
            ).fetchone()
        return int(row["sequence"]) if row else 0
