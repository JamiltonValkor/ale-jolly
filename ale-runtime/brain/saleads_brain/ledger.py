"""Ledger SQLite del cerebro (portado y recortado de ORQA).

Guarda eventos, outbox, propuestas de ontología, conocimiento bitemporal y
auditoría. No incluye el kernel de ORQA ni `kernel_trace`.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from saleads_brain import governance
from saleads_brain.provenance import Provenance
from saleads_brain.states import VerificationState, visible_state

SCHEMA_VERSION = 6
# v2 (MLB-009): confianza, conteo de evidencia y nodo del grafo de cada aprendizaje.
_V2_COLUMNS = (("confidence", "TEXT"), ("evidence_count", "INTEGER NOT NULL DEFAULT 1"), ("graph_uuid", "TEXT"))
# v3 (AAB-019): hechos tipados del dueño por ruta de BI, bitemporales (revisiones; solo una vigente por ruta).
_V3_DDL = """
CREATE TABLE IF NOT EXISTS fact_revisions (
    revision_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, path TEXT NOT NULL, offering_ref TEXT,
    value_json TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL, observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL, superseded_at TEXT, version INTEGER NOT NULL, reason TEXT,
    UNIQUE(business_id, path, offering_ref, version));
CREATE INDEX IF NOT EXISTS fact_current_idx ON fact_revisions(business_id, path, offering_ref)
    WHERE superseded_at IS NULL;
"""
# MCL-007: sources, scoped typed revisions, projection receipts and goal history.
# Existing records remain unchanged; writers opt in through the managed adapter.
_V4_DDL = """
CREATE TABLE IF NOT EXISTS memory_sources (
    event_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, business_id TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE, evidence_key TEXT NOT NULL, payload_json TEXT NOT NULL,
    registered_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_source_aliases (
    owner_id TEXT NOT NULL, business_id TEXT NOT NULL, alias TEXT NOT NULL, event_id TEXT NOT NULL,
    PRIMARY KEY(owner_id, business_id, alias));
CREATE TABLE IF NOT EXISTS memory_knowledge (
    record_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, business_id TEXT NOT NULL,
    scope TEXT NOT NULL, role TEXT NOT NULL, canonical_id TEXT NOT NULL,
    revision INTEGER NOT NULL, payload_json TEXT NOT NULL, provenance TEXT NOT NULL,
    verification TEXT NOT NULL, evidence_keys_json TEXT NOT NULL, evidence_count INTEGER NOT NULL,
    effective INTEGER NOT NULL, superseded_by TEXT, projection_status TEXT NOT NULL DEFAULT 'pending',
    recorded_at TEXT NOT NULL,
    UNIQUE(owner_id, business_id, scope, role, canonical_id, revision));
CREATE INDEX IF NOT EXISTS memory_knowledge_current_idx ON memory_knowledge(owner_id,business_id,scope,role,effective);
CREATE TABLE IF NOT EXISTS memory_knowledge_aliases (
    owner_id TEXT NOT NULL, business_id TEXT NOT NULL, alias TEXT NOT NULL, record_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, PRIMARY KEY(owner_id,business_id,alias));
CREATE TABLE IF NOT EXISTS memory_goals (
    owner_id TEXT NOT NULL, business_id TEXT NOT NULL, goal_id TEXT NOT NULL,
    revision INTEGER NOT NULL, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,business_id,goal_id,revision));
"""
_V5_DDL = """
CREATE TABLE IF NOT EXISTS curation_batches (
    batch_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, business_id TEXT NOT NULL,
    stream TEXT NOT NULL, payload_json TEXT NOT NULL, tokens INTEGER, cost_usd REAL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS curation_sources (
    event_id TEXT PRIMARY KEY, batch_id TEXT, state TEXT NOT NULL,
    reason TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS curation_cursors (
    owner_id TEXT NOT NULL, business_id TEXT NOT NULL, stream TEXT NOT NULL,
    sequence INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,business_id,stream));
"""
CURATOR_ID = "saleads:ontology-curator"

_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, kind TEXT NOT NULL,
    provenance TEXT NOT NULL, source_uri TEXT NOT NULL, content_hash TEXT NOT NULL,
    occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(event_id),
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ontology_proposals (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, proposal_kind TEXT NOT NULL,
    name TEXT NOT NULL, definition TEXT NOT NULL, schema_json TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL, independent_source_count INTEGER NOT NULL,
    status TEXT NOT NULL, proposer_id TEXT NOT NULL, reviewer_id TEXT, review_note TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(business_id, proposal_kind, name));
CREATE TABLE IF NOT EXISTS knowledge_revisions (
    revision_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, canonical_id TEXT NOT NULL,
    statement TEXT NOT NULL, provenance TEXT NOT NULL, verification TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL, valid_from TEXT, valid_to TEXT,
    recorded_at TEXT NOT NULL, superseded_at TEXT, version INTEGER NOT NULL,
    supersedes_ref TEXT, UNIQUE(canonical_id, version));
CREATE INDEX IF NOT EXISTS knowledge_temporal_idx ON knowledge_revisions(
    canonical_id, valid_from, valid_to, recorded_at, superseded_at);
CREATE TABLE IF NOT EXISTS checkpoints (
    source TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS loops (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')), opened_at TEXT NOT NULL,
    closed_at TEXT, closing_evidence TEXT);
CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL, business_id TEXT NOT NULL, tokens REAL NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, business_id));
CREATE TABLE IF NOT EXISTS noise_daily (
    day TEXT PRIMARY KEY, assistant_messages INTEGER NOT NULL DEFAULT 0,
    owner_messages INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, text TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('owner_said', 'owner_decided')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'shared', 'rejected', 'discarded')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor_id TEXT NOT NULL,
    object_type TEXT NOT NULL, object_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL);
"""


def now() -> str:
    return datetime.now(UTC).isoformat()


def _utc(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps_must_be_timezone_aware")
    return parsed.astimezone(UTC).isoformat()


def stable_id(*parts: object) -> str:
    material = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(material.encode()).hexdigest()[:32]


def _evidence_count(refs: list[str]) -> int:
    # An anchor links the lesson to its subject; it is not a second observation.
    observations = {ref for ref in refs if not ref.startswith("graph:")}
    return len(observations or set(refs))


class Ledger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db:
            db.executescript(_DDL)
        with self.transaction() as db:
            self._migrate(db)

    def _migrate(self, db: sqlite3.Connection) -> None:
        """Idempotente: agrega lo que falta y anota cada versión una sola vez."""
        db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1,?)", (now(),))
        columns = {row["name"] for row in db.execute("PRAGMA table_info(knowledge_revisions)")}
        for name, ddl in _V2_COLUMNS:
            if name not in columns:
                db.execute(f"ALTER TABLE knowledge_revisions ADD COLUMN {name} {ddl}")
        db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2,?)", (now(),))
        for statement in (part.strip() for part in _V3_DDL.split(";")):
            if statement:
                db.execute(statement)
        db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3,?)", (now(),))
        for statement in (part.strip() for part in _V4_DDL.split(";")):
            if statement:
                db.execute(statement)
        db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4,?)", (now(),))
        for statement in (part.strip() for part in _V5_DDL.split(";")):
            if statement:
                db.execute(statement)
        db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5,?)", (now(),))
        columns = {row["name"] for row in db.execute("PRAGMA table_info(curation_batches)")}
        if "commit_request_sha256" not in columns:
            db.execute(
                "ALTER TABLE curation_batches ADD COLUMN commit_request_sha256 TEXT "
                "CHECK(commit_request_sha256 IS NULL OR (length(commit_request_sha256)=64 "
                "AND commit_request_sha256 NOT GLOB '*[^0-9a-f]*'))"
            )
        # Historical terminal batches deliberately keep NULL: their request is unknown.
        db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6,?)", (now(),))

    def schema_versions(self) -> list[int]:
        with closing(self.connect()) as db:
            return [int(row["version"]) for row in db.execute("SELECT version FROM schema_migrations ORDER BY version")]

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with closing(self.connect()) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    @contextmanager
    def curation_commit_lock(self) -> Iterator[None]:
        """Serialize finalizers across processes without nesting SQLite writes.

        The OS releases the short-lived critical section on process exit. This
        is not a durable claim, authorization lease, or alternate queue state.
        Candidate ledger/graph recovery retains its existing separate commits.
        """
        path = self.path.with_name(self.path.name + ".curation-commit.lock")
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    # Hechos tipados (AAB-019) -------------------------------------------------
    def current_fact(self, business_id: str, path: str, offering_ref: str | None) -> dict[str, Any] | None:
        with closing(self.connect()) as db:
            row = db.execute(
                "SELECT * FROM fact_revisions WHERE business_id=? AND path=? AND offering_ref IS ? "
                "AND superseded_at IS NULL",
                (business_id, path, offering_ref),
            ).fetchone()
        return self._fact(row) if row else None

    def add_fact_revision(
        self,
        *,
        business_id: str,
        path: str,
        offering_ref: str | None,
        value: object,
        provenance: str,
        evidence: str,
        observed_at: str,
        applied: bool,
        reason: str | None = None,
    ) -> dict[str, Any]:
        """Nueva revisión. `applied` cierra la vigente y la reemplaza; si no, queda guardada sin ser vigente."""
        recorded = now()
        with self.transaction() as db:
            version = int(
                db.execute(
                    "SELECT COALESCE(MAX(version), 0) FROM fact_revisions "
                    "WHERE business_id=? AND path=? AND offering_ref IS ?",
                    (business_id, path, offering_ref),
                ).fetchone()[0]
            ) + 1
            revision_id = stable_id(business_id, path, offering_ref, version)
            if applied:
                db.execute(
                    "UPDATE fact_revisions SET superseded_at=? WHERE business_id=? AND path=? AND offering_ref IS ? "
                    "AND superseded_at IS NULL",
                    (recorded, business_id, path, offering_ref),
                )
            db.execute(
                "INSERT INTO fact_revisions(revision_id, business_id, path, offering_ref, value_json, provenance, "
                "evidence, observed_at, recorded_at, superseded_at, version, reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    revision_id, business_id, path, offering_ref, json.dumps(value, ensure_ascii=False),
                    provenance, evidence, _utc(observed_at), recorded, None if applied else recorded, version, reason,
                ),
            )
            row = db.execute("SELECT * FROM fact_revisions WHERE revision_id=?", (revision_id,)).fetchone()
        return self._fact(row)

    def current_facts(self, business_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT * FROM fact_revisions WHERE business_id=? AND superseded_at IS NULL "
                "ORDER BY path, offering_ref LIMIT ?",
                (business_id, limit),
            ).fetchall()
        return [self._fact(row) for row in rows]

    @staticmethod
    def _fact(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "revision_id": row["revision_id"], "business_id": row["business_id"], "path": row["path"],
            "offering_ref": row["offering_ref"], "value": json.loads(row["value_json"]),
            "provenance": row["provenance"], "evidence": row["evidence"], "observed_at": row["observed_at"],
            "recorded_at": row["recorded_at"], "superseded_at": row["superseded_at"], "version": int(row["version"]),
            "reason": row["reason"],
        }

    # Eventos -----------------------------------------------------------------
    def record_event(
        self,
        *,
        business_id: str,
        kind: str,
        provenance: Provenance,
        source_uri: str,
        occurred_at: str,
        payload: dict[str, Any],
    ) -> str:
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        content_hash = hashlib.sha256(canonical.encode()).hexdigest()
        event_id = stable_id(business_id, kind, source_uri, content_hash)
        with self.transaction() as db:
            inserted = db.execute(
                "INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    event_id,
                    business_id,
                    kind,
                    Provenance(provenance).value,
                    source_uri,
                    content_hash,
                    _utc(occurred_at),
                    now(),
                    canonical,
                ),
            ).rowcount
            if inserted:
                db.execute("INSERT INTO outbox(event_id, updated_at) VALUES(?,?)", (event_id, now()))
        return event_id

    def pending_outbox(self, limit: int = 50) -> list[dict[str, Any]]:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT o.id, e.* FROM outbox o JOIN events e USING(event_id) "
                "WHERE o.status='pending' ORDER BY o.id LIMIT ?",
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [dict(row) for row in rows]

    def complete_outbox(self, outbox_id: int) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE outbox SET status='complete', last_error=NULL, updated_at=? WHERE id=?",
                (now(), outbox_id),
            )

    # Ontología ---------------------------------------------------------------
    def propose_ontology_change(
        self,
        *,
        business_id: str,
        proposal_kind: str,
        name: str,
        definition: str,
        schema: dict[str, Any],
        evidence_refs: list[str],
        proposer_id: str,
    ) -> str:
        independent = governance.validate_proposal(proposal_kind=proposal_kind, name=name, evidence_refs=evidence_refs)
        proposal_id = stable_id("ontology", business_id, proposal_kind, name)
        with self.transaction() as db:
            db.execute(
                "INSERT OR IGNORE INTO ontology_proposals(id, business_id, proposal_kind, name, "
                "definition, schema_json, evidence_refs_json, independent_source_count, status, "
                "proposer_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,'PROPOSED',?,?,?)",
                (
                    proposal_id,
                    business_id,
                    proposal_kind,
                    name,
                    definition,
                    json.dumps(schema, ensure_ascii=False, sort_keys=True),
                    json.dumps(independent, ensure_ascii=False),
                    len(independent),
                    proposer_id,
                    now(),
                    now(),
                ),
            )
        return proposal_id

    def review_ontology_proposal(self, *, proposal_id: str, target_status: str, reviewer_id: str, note: str) -> None:
        with self.transaction() as db:
            row = self._proposal(db, proposal_id)
            governance.assert_transition(row["status"], target_status)
            self._set_status(db, row, target_status, reviewer_id, note, "ontology_review")

    def activate_safe_semantic(self, *, proposal_id: str, note: str) -> None:
        """Activa vocabulario aditivo sin pasar por el dueño, solo si es seguro."""
        with self.transaction() as db:
            row = self._proposal(db, proposal_id)
            if row["status"] not in {"PROPOSED", "REVIEWED"}:
                raise ValueError(f"semantic_proposal_not_activatable:{row['status']}")
            governance.assert_safe_semantic(
                name=row["name"],
                definition=row["definition"],
                schema=json.loads(row["schema_json"]),
                independent_sources=int(row["independent_source_count"]),
            )
            self._set_status(db, row, "ACTIVE", CURATOR_ID, note, "ontology_auto_semantic")

    def active_ontology(self, business_id: str) -> dict[str, Any]:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT * FROM ontology_proposals WHERE business_id=? AND status='ACTIVE' ORDER BY proposal_kind, name",
                (business_id,),
            ).fetchall()
        return {
            "schema": "saleads-learned-ontology/1",
            "proposals": [
                {
                    "name": r["name"],
                    "proposal_kind": r["proposal_kind"],
                    "definition": r["definition"],
                    "schema": json.loads(r["schema_json"]),
                    "evidence_refs": json.loads(r["evidence_refs_json"]),
                }
                for r in rows
            ],
        }

    def export_active_ontology(self, business_id: str, output: str | Path) -> Path:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(self.active_ontology(business_id), ensure_ascii=False, indent=2))
        tmp.replace(path)
        return path

    # Conocimiento bitemporal -------------------------------------------------
    def record_knowledge(
        self,
        *,
        business_id: str,
        statement: str,
        provenance: Provenance,
        verification: VerificationState,
        evidence_refs: list[str],
        valid_from: str | None = None,
        supersedes_revision_id: str | None = None,
        confidence: str | None = None,
    ) -> dict[str, Any]:
        """Guarda una revisión inmutable. Cambiar algo exige reemplazar, nunca sobrescribir."""
        evidence = sorted({ref for ref in evidence_refs if ref.strip()})
        if not statement.strip() or not evidence:
            raise ValueError("knowledge_requires_statement_and_evidence")
        recorded = now()
        with self.transaction() as db:
            if supersedes_revision_id:
                prior = db.execute(
                    "SELECT * FROM knowledge_revisions WHERE revision_id=?",
                    (supersedes_revision_id,),
                ).fetchone()
                if prior is None or prior["superseded_at"] is not None:
                    raise ValueError("knowledge_supersedes_revision_not_current")
                if prior["business_id"] != business_id:
                    raise ValueError("knowledge_supersedes_cross_business")
                canonical_id, version = prior["canonical_id"], int(prior["version"]) + 1
                db.execute(
                    "UPDATE knowledge_revisions SET superseded_at=? WHERE revision_id=?",
                    (recorded, supersedes_revision_id),
                )
            else:
                normalized = " ".join(statement.split()).casefold()
                canonical_id = "knowledge-" + stable_id(business_id, normalized)
                current = db.execute(
                    "SELECT * FROM knowledge_revisions WHERE canonical_id=? AND superseded_at IS NULL",
                    (canonical_id,),
                ).fetchone()
                if current is not None:
                    return self._knowledge(current)
                version = 1
            revision_id = stable_id(canonical_id, version)
            db.execute(
                "INSERT INTO knowledge_revisions(revision_id, business_id, canonical_id, statement, provenance, "
                "verification, evidence_refs_json, valid_from, valid_to, recorded_at, superseded_at, version, "
                "supersedes_ref, confidence, evidence_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    revision_id,
                    business_id,
                    canonical_id,
                    statement,
                    Provenance(provenance).value,
                    VerificationState(verification).value,
                    json.dumps(evidence),
                    _utc(valid_from) if valid_from else None,
                    None,
                    recorded,
                    None,
                    version,
                    supersedes_revision_id,
                    confidence,
                    _evidence_count(evidence),
                ),
            )
            row = db.execute("SELECT * FROM knowledge_revisions WHERE revision_id=?", (revision_id,)).fetchone()
        return self._knowledge(row)

    def reinforce_knowledge(self, revision_id: str, evidence_refs: list[str]) -> dict[str, Any]:
        """Union of source identities; replay is not independent evidence."""
        with self.transaction() as db:
            row = db.execute("SELECT * FROM knowledge_revisions WHERE revision_id=?", (revision_id,)).fetchone()
            if row is None or row["superseded_at"] is not None:
                raise ValueError("knowledge_revision_not_current")
            refs = sorted(set(json.loads(row["evidence_refs_json"])) | {r for r in evidence_refs if r.strip()})
            db.execute(
                "UPDATE knowledge_revisions SET evidence_refs_json=?, evidence_count=? "
                "WHERE revision_id=?",
                (json.dumps(refs), _evidence_count(refs), revision_id),
            )
            row = db.execute("SELECT * FROM knowledge_revisions WHERE revision_id=?", (revision_id,)).fetchone()
        return self._knowledge(row)

    def link_knowledge(self, revision_id: str, graph_uuid: str) -> None:
        with self.transaction() as db:
            db.execute("UPDATE knowledge_revisions SET graph_uuid=? WHERE revision_id=?", (graph_uuid, revision_id))

    def knowledge_by_graph_uuid(self, graph_uuid: str) -> dict[str, Any] | None:
        with closing(self.connect()) as db:
            row = db.execute(
                "SELECT * FROM knowledge_revisions WHERE graph_uuid=? ORDER BY version DESC LIMIT 1", (graph_uuid,)
            ).fetchone()
        return self._knowledge(row) if row else None

    def knowledge_at(self, canonical_id: str, *, valid_at: str, known_at: str) -> list[dict[str, Any]]:
        valid, known = _utc(valid_at), _utc(known_at)
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT * FROM knowledge_revisions WHERE canonical_id=? AND recorded_at<=? "
                "AND (superseded_at IS NULL OR superseded_at>?) "
                "AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>?) "
                "ORDER BY version DESC",
                (canonical_id, known, known, valid, valid),
            ).fetchall()
        return [self._knowledge(row) for row in rows]

    # Puntos de control, loops, costo, ruido y lecciones (OSB-004) -------------
    def checkpoint(self, source: str) -> str | None:
        with closing(self.connect()) as db:
            row = db.execute("SELECT cursor FROM checkpoints WHERE source=?", (source,)).fetchone()
        return str(row["cursor"]) if row else None

    def set_checkpoint(self, source: str, cursor: str) -> None:
        with self.transaction() as db:
            db.execute(
                "INSERT INTO checkpoints(source, cursor, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at",
                (source, cursor, now()),
            )

    def open_loop(self, *, business_id: str, title: str, kind: str) -> str:
        loop_id = stable_id("loop", business_id, kind, title)
        with self.transaction() as db:
            db.execute(
                "INSERT OR IGNORE INTO loops(id, business_id, title, kind, status, opened_at) VALUES(?,?,?,?,'open',?)",
                (loop_id, business_id, title, kind, now()),
            )
        return loop_id

    def close_loop(self, loop_id: str, evidence: str) -> bool:
        if not evidence.strip():
            raise ValueError("loop_close_requires_evidence")
        with self.transaction() as db:
            closed = db.execute(
                "UPDATE loops SET status='closed', closed_at=?, closing_evidence=? WHERE id=? AND status='open'",
                (now(), evidence, loop_id),
            ).rowcount
        return bool(closed)

    def loops(self, business_id: str | None = None, status: str = "open") -> list[dict[str, Any]]:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT * FROM loops WHERE status=? AND (? IS NULL OR business_id=?) ORDER BY opened_at",
                (status, business_id, business_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def add_usage(self, day: str, business_id: str, tokens: float, cost_usd: float, calls: int) -> None:
        with self.transaction() as db:
            db.execute(
                "INSERT INTO usage_daily(day, business_id, tokens, cost_usd, calls) VALUES(?,?,?,?,?) "
                "ON CONFLICT(day, business_id) DO UPDATE SET tokens=tokens+excluded.tokens, "
                "cost_usd=cost_usd+excluded.cost_usd, calls=calls+excluded.calls",
                (day, business_id, tokens, cost_usd, calls),
            )

    def set_noise(self, day: str, assistant_messages: int, owner_messages: int) -> None:
        with self.transaction() as db:
            db.execute(
                "INSERT INTO noise_daily(day, assistant_messages, owner_messages) VALUES(?,?,?) "
                "ON CONFLICT(day) DO UPDATE SET assistant_messages=excluded.assistant_messages, "
                "owner_messages=excluded.owner_messages",
                (day, assistant_messages, owner_messages),
            )

    def add_noise(self, day: str, assistant_messages: int, owner_messages: int) -> None:
        """Suma los mensajes del día (cada mensaje se cuenta una sola vez: lo garantiza el checkpoint)."""
        with self.transaction() as db:
            db.execute(
                "INSERT INTO noise_daily(day, assistant_messages, owner_messages) VALUES(?,?,?) "
                "ON CONFLICT(day) DO UPDATE SET assistant_messages=assistant_messages+excluded.assistant_messages, "
                "owner_messages=owner_messages+excluded.owner_messages",
                (day, assistant_messages, owner_messages),
            )

    def value_report(self, business_id: str, since_day: str) -> dict[str, Any]:
        with closing(self.connect()) as db:
            usage = db.execute(
                "SELECT COALESCE(SUM(tokens),0) t, COALESCE(SUM(cost_usd),0) c FROM usage_daily "
                "WHERE business_id=? AND day>=?",
                (business_id, since_day),
            ).fetchone()
            noise = db.execute(
                "SELECT COALESCE(SUM(assistant_messages),0) a, COALESCE(SUM(owner_messages),0) o "
                "FROM noise_daily WHERE day>=?",
                (since_day,),
            ).fetchone()
            loops = db.execute(
                "SELECT status, COUNT(*) n FROM loops WHERE business_id=? AND opened_at>=? GROUP BY status",
                (business_id, since_day),
            ).fetchall()
        counts = {row["status"]: row["n"] for row in loops}
        owner = int(noise["o"])
        return {
            "since": since_day,
            "ai_tokens": float(usage["t"]),
            "ai_cost_usd": round(float(usage["c"]), 4),
            "assistant_messages": int(noise["a"]),
            "owner_messages": owner,
            "noise_ratio": round(int(noise["a"]) / owner, 2) if owner else None,
            "loops_closed": int(counts.get("closed", 0)),
            "loops_open": int(counts.get("open", 0)),
        }

    def add_lesson(self, *, business_id: str, text: str, provenance: str) -> str | None:
        lesson_id = stable_id("lesson", business_id, " ".join(text.split()).casefold())
        with self.transaction() as db:
            inserted = db.execute(
                "INSERT OR IGNORE INTO lessons(id, business_id, text, provenance, status, created_at, updated_at) "
                "VALUES(?,?,?,?,'pending',?,?)",
                (lesson_id, business_id, text, provenance, now(), now()),
            ).rowcount
        return lesson_id if inserted else None

    def lessons(self, status: str = "pending", limit: int = 20) -> list[dict[str, Any]]:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT id, business_id, text, provenance, status, created_at FROM lessons WHERE status=? "
                "ORDER BY created_at LIMIT ?",
                (status, max(1, min(limit, 100))),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_lesson(self, lesson_id: str, status: str) -> bool:
        if status not in {"shared", "rejected", "discarded"}:
            raise ValueError("invalid_lesson_status")
        with self.transaction() as db:
            return bool(
                db.execute(
                    "UPDATE lessons SET status=?, updated_at=? WHERE id=? AND status='pending'",
                    (status, now(), lesson_id),
                ).rowcount
            )

    # Internos ----------------------------------------------------------------
    @staticmethod
    def _proposal(db: sqlite3.Connection, proposal_id: str) -> sqlite3.Row:
        row = db.execute("SELECT * FROM ontology_proposals WHERE id=?", (proposal_id,)).fetchone()
        if row is None:
            raise KeyError("ontology_proposal_not_found")
        return row  # type: ignore[no-any-return]

    @staticmethod
    def _set_status(db: sqlite3.Connection, row: sqlite3.Row, status: str, actor: str, note: str, action: str) -> None:
        db.execute(
            "UPDATE ontology_proposals SET status=?, reviewer_id=?, review_note=?, updated_at=? WHERE id=?",
            (status, actor, note, now(), row["id"]),
        )
        db.execute(
            "INSERT INTO audit_log(action, actor_id, object_type, object_id, payload_json, "
            "occurred_at) VALUES(?,?,'ontology_proposal',?,?,?)",
            (
                action,
                actor,
                row["id"],
                json.dumps({"from": row["status"], "to": status, "note": note}),
                now(),
            ),
        )

    @staticmethod
    def _knowledge(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        value["evidence_refs"] = json.loads(value.pop("evidence_refs_json"))
        value["visible_state"] = (
            "superseded" if value["superseded_at"] else visible_state(VerificationState(value["verification"])).value
        )
        return value
