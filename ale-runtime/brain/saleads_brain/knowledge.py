"""Source-validated, business-scoped memory without inference or embeddings.

The collector registers sources with authenticated bindings. The curator only
submits candidates referencing that registry; its token does not turn its words
into owner statements. SQLite commits precede recoverable graph projection.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from saleads_brain.graph import Edge, GraphStore, Node
from saleads_brain.ledger import Ledger, now, stable_id
from saleads_brain.ontology import base
from saleads_brain.provenance import Provenance
from saleads_brain.settings import group_id
from saleads_brain.states import VerificationState

SOURCE_AUTHORS = {
    "owner_message": "owner",
    "specialist_result": "specialist",
    "cron_result": "cron",
    "api_observation": "api",
    "server_instruction": "server",
    "operator_canary": "operator",
}
NON_BUSINESS_SOURCES = {"server_instruction", "operator_canary"}


class MemoryError(ValueError):
    """Stable rejection code, never source content."""


@dataclass(frozen=True, slots=True)
class MemoryContext:
    """Server-created binding. Never deserialize this from a curator argument."""

    owner_id: str
    business_id: str
    actor_role: str = "curador"
    actor_id: str = "curador"


def validate_contract(name: str, payload: dict[str, Any]) -> None:
    schema = json.loads(resources.files("saleads_brain").joinpath(f"contracts/mcl/{name}.schema.json").read_text())
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(payload))
    if errors:
        raise MemoryError(f"invalid_{name.replace('-', '_')}_contract")


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _normalized(value: str) -> str:
    return " ".join(value.split()).casefold()


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def _bound(context: MemoryContext, payload: dict[str, Any]) -> None:
    if (payload["owner_id"], payload["business_id"]) != (context.owner_id, context.business_id):
        raise MemoryError("memory_binding_mismatch")


class MemoryWriter:
    def __init__(self, ledger: Ledger, store: GraphStore,
                 source_admission: Callable[[str, str, dict[str, Any]], str | None] | None = None) -> None:
        self.ledger, self.store = ledger, store
        self.source_admission = source_admission

    def register_source(self, context: MemoryContext, event: dict[str, Any], *, aliases: tuple[str, ...] = ()) -> str:
        """Trusted collector entry point; not exposed as a model-write tool."""
        validate_contract("source-event", event)
        _bound(context, event)
        if SOURCE_AUTHORS[event["source_kind"]] != event["author"]["kind"]:
            raise MemoryError("source_author_mismatch")
        if event["source_kind"] == "operator_canary" and event["purpose"] != "technical_canary":
            raise MemoryError("operator_source_is_technical")
        if event["source_kind"] == "owner_message" and event["author"]["id"] != context.owner_id:
            raise MemoryError("owner_author_mismatch")
        if hashlib.sha256(event["content"].encode()).hexdigest() != event["content_sha256"]:
            raise MemoryError("source_content_hash_mismatch")
        source_key = stable_id(
            context.owner_id, context.business_id, event["source_kind"], event["source_id"], event["source_version"]
        )
        # Changing extractor or replaying a new version of one episode is not a
        # second independent observation of the same claim.
        evidence_key = stable_id(context.owner_id, context.business_id, event["source_kind"], event["source_id"])
        with self.ledger.transaction() as db:
            previous = db.execute("SELECT * FROM memory_sources WHERE source_key=?", (source_key,)).fetchone()
            canonical_id = event["event_id"]
            if previous is not None:
                stored = json.loads(previous["payload_json"])
                if stored["content_sha256"] != event["content_sha256"] or stored["author"] != event["author"]:
                    raise MemoryError("source_identity_conflict")
                canonical_id = str(previous["event_id"])
            else:
                collision = db.execute("SELECT 1 FROM memory_sources WHERE event_id=?", (canonical_id,)).fetchone()
                if collision:
                    raise MemoryError("source_identity_conflict")
                db.execute(
                    "INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?)",
                    (
                        canonical_id,
                        context.owner_id,
                        context.business_id,
                        source_key,
                        evidence_key,
                        _canonical(event),
                        now(),
                    ),
                )
            for alias in {event["event_id"], *aliases}:
                prior = db.execute(
                    "SELECT event_id FROM memory_source_aliases WHERE owner_id=? AND business_id=? AND alias=?",
                    (context.owner_id, context.business_id, alias),
                ).fetchone()
                if prior is not None and prior["event_id"] != canonical_id:
                    raise MemoryError("source_alias_conflict")
                db.execute(
                    "INSERT OR IGNORE INTO memory_source_aliases VALUES(?,?,?,?)",
                    (
                        context.owner_id,
                        context.business_id,
                        alias,
                        canonical_id,
                    ),
                )
        return str(canonical_id)

    def source(self, context: MemoryContext, event_id: str) -> dict[str, Any]:
        with closing(self.ledger.connect()) as db:
            row = db.execute(
                "SELECT s.* FROM memory_sources s JOIN memory_source_aliases a USING(event_id) "
                "WHERE a.owner_id=? AND a.business_id=? AND a.alias=? AND s.owner_id=? AND s.business_id=?",
                (context.owner_id, context.business_id, event_id, context.owner_id, context.business_id),
            ).fetchone()
        if row is None:
            raise MemoryError("source_not_found_in_business")
        payload = json.loads(row["payload_json"])
        if payload["source_kind"] == "specialist_result" and context.actor_role not in (
            "curador",
            payload["author"]["id"].removeprefix("specialist:"),
        ):
            raise MemoryError("private_source_role_mismatch")
        return {**payload, "_evidence_key": row["evidence_key"]}

    def _sources(self, context: MemoryContext, ids: list[str]) -> list[dict[str, Any]]:
        found = {source["event_id"]: source for source in (self.source(context, ref) for ref in ids)}
        sources = list(found.values())
        if any(
            source["purpose"] != "business_work" or source["source_kind"] in NON_BUSINESS_SOURCES for source in sources
        ):
            raise MemoryError("non_business_source_not_admissible")
        if self.source_exclusions(context, ids):
            raise MemoryError("non_business_source_not_admissible")
        return sources

    def source_exclusions(self, context: MemoryContext, refs: list[str]) -> list[dict[str, str]]:
        """Eligibility metadata only; business summaries never read a private source payload."""
        if self.source_admission is None:
            return []
        excluded = []
        with closing(self.ledger.connect()) as db:
            for ref in dict.fromkeys(refs):
                row = db.execute(
                    "SELECT s.owner_id,s.business_id,json_extract(s.payload_json,'$.source_kind') AS source_kind,"
                    "json_extract(s.payload_json,'$.source_id') AS source_id "
                    "FROM memory_sources s JOIN memory_source_aliases a USING(event_id) "
                    "WHERE a.owner_id=? AND a.business_id=? AND a.alias=? AND s.owner_id=? AND s.business_id=?",
                    (context.owner_id, context.business_id, ref, context.owner_id, context.business_id),
                ).fetchone()
                if row is None:
                    raise MemoryError("source_not_found_in_business")
                reason = self.source_admission(context.owner_id, context.business_id, dict(row))
                if reason:
                    excluded.append({"event_id": ref, "reason": reason})
        return excluded

    def candidate(self, context: MemoryContext, candidate: dict[str, Any]) -> dict[str, Any]:
        validate_contract("knowledge-candidate", candidate)
        _bound(context, candidate)
        if candidate["extractor_id"] != context.actor_id:
            raise MemoryError("extractor_identity_mismatch")
        role, scope = candidate["specialist_role"], candidate["scope"]
        if (scope == "specialist") != (role is not None):
            raise MemoryError("specialist_scope_requires_role")
        if role and context.actor_role not in (role, "ale", "curador"):
            raise MemoryError("private_experience_role_mismatch")
        if candidate["entity_type"] not in base().entities:
            raise MemoryError("unknown_ontology_type")
        if candidate["entity_type"] in {"Bet", "AdSet", "Ad", "Result", "Verdict", "SpecialistExperience"}:
            raise MemoryError("dedicated_writer_required")
        if base().entities[candidate["entity_type"]].deprecated:
            raise MemoryError("deprecated_ontology_type")
        if candidate["attributes"].get("field"):
            if not candidate["attributes"].get("subject_ref"):
                raise MemoryError("scalar_fact_requires_subject_ref")
            try:
                base().field_kind(candidate["entity_type"], candidate["attributes"]["field"])
            except KeyError as error:
                raise MemoryError("unknown_ontology_field") from error
        if candidate["attributes"].get("derived_from_ref"):
            target = self.get(context, candidate["attributes"]["derived_from_ref"])
            target_type = (
                "SpecialistExperience"
                if target["payload"]["schema_version"] == "specialist-experience/1"
                else target["payload"]["entity_type"]
            )
            if not base().permits_relation(candidate["entity_type"], "DERIVED_FROM", target_type):
                raise MemoryError("undeclared_ontology_relation")
        self._validity(candidate)
        sources = self._sources(context, candidate["source_event_ids"])
        state, provenance, verification = self._admission(candidate, sources)
        admitted = {**candidate, "validation_state": state, "source_event_ids": [s["event_id"] for s in sources]}
        return self._commit(context, admitted, candidate["candidate_id"], sources, provenance, verification)

    @staticmethod
    def _validity(payload: dict[str, Any]) -> None:
        if payload["valid_until"] and _instant(payload["valid_until"]) <= _instant(payload["valid_from"]):
            raise MemoryError("invalid_validity_window")

    @staticmethod
    def _admission(candidate: dict[str, Any], sources: list[dict[str, Any]]) -> tuple[str, str, str]:
        epistemic, requested = candidate["epistemic"], candidate["validation_state"]
        owners = [s for s in sources if s["source_kind"] == "owner_message"]
        platform = any(s["source_kind"] == "api_observation" for s in sources)
        if epistemic == "inferred":
            if requested == "confirmed":
                raise MemoryError("inference_is_not_confirmed_fact")
            return (
                requested,
                (Provenance.INFERRED_FROM_PLATFORM if platform else Provenance.INFERRED).value,
                VerificationState.INFERRED.value,
            )
        if epistemic == "declared":
            quote = str(candidate["attributes"].get("owner_quote") or candidate["content"])
            if not owners or not any(_normalized(quote) in _normalized(s["content"]) for s in owners):
                raise MemoryError("owner_quote_not_in_registered_source")
            if not any(_normalized(candidate["content"]) in _normalized(s["content"]) for s in owners):
                return "proposed", Provenance.INFERRED.value, VerificationState.PROPOSED.value
            # Admission is not proof that a claim is true. Unsupported proof is
            # always a proposal, even if an owner mentioned it.
            if candidate["entity_type"] == "Proof":
                return "proposed", Provenance.OWNER_SAID.value, VerificationState.PROPOSED.value
            provenance = Provenance.OWNER_DECIDED if candidate["entity_type"] == "Decision" else Provenance.OWNER_SAID
            return requested, provenance.value, VerificationState.HUMAN_VALIDATED.value
        if platform:
            if requested == "confirmed" and not MemoryWriter._observed_supported(candidate, sources):
                return "proposed", Provenance.INFERRED_FROM_PLATFORM.value, VerificationState.PROPOSED.value
            return requested, Provenance.PLATFORM.value, VerificationState.SYSTEM_VERIFIED.value
        return (
            "proposed" if requested == "confirmed" else requested,
            Provenance.INFERRED.value,
            VerificationState.OBSERVED.value,
        )

    @staticmethod
    def _observed_supported(candidate: dict[str, Any], sources: list[dict[str, Any]]) -> bool:
        attrs = candidate["attributes"]
        field = attrs.get("source_field") or attrs.get("field")
        for source in sources:
            if source["source_kind"] != "api_observation":
                continue
            if _normalized(candidate["content"]) in _normalized(source["content"]):
                return True
            if field and "value" in attrs:
                try:
                    value: Any = json.loads(source["content"])
                    if (
                        isinstance(value, dict)
                        and isinstance(value.get("fields"), list)
                        and any(
                            isinstance(item, dict)
                            and item.get("entity_type") == candidate["entity_type"]
                            and item.get("subject_ref") == attrs.get("subject_ref")
                            and item.get("field") == attrs.get("field")
                            and item.get("value") == attrs["value"]
                            for item in value["fields"]
                        )
                    ):
                        return True
                    for part in str(field).split("."):
                        value = value[int(part)] if isinstance(value, list) and part.isdecimal() else value[part]
                    if value == attrs["value"]:
                        return True
                except (ValueError, KeyError, IndexError, TypeError):
                    continue
        return False

    def experience(self, context: MemoryContext, experience: dict[str, Any]) -> dict[str, Any]:
        validate_contract("specialist-experience", experience)
        _bound(context, experience)
        self._validity(experience)
        role = experience["specialist_role"]
        if context.actor_role not in (role, "ale", "curador"):
            raise MemoryError("private_experience_role_mismatch")
        sources = self._sources(context, experience["source_event_ids"])
        matching = [
            s
            for s in sources
            if s["source_kind"] == "specialist_result"
            and s["native_task_id"] == experience["task_id"]
            and s["native_run_id"] == experience["run_id"]
            and s["author"]["id"] in (role, f"specialist:{role}")
        ]
        if not matching:
            raise MemoryError("experience_requires_native_role_result")
        confidence = experience["confidence"]
        if confidence == "validated" and not any(s["source_kind"] == "owner_message" for s in sources):
            confidence = "supported"
        admitted = {**experience, "confidence": confidence, "source_event_ids": [s["event_id"] for s in sources]}
        return self._commit(
            context,
            admitted,
            experience["experience_id"],
            sources,
            Provenance.INFERRED.value,
            VerificationState.OBSERVED.value,
        )

    def _commit(
        self,
        context: MemoryContext,
        payload: dict[str, Any],
        alias: str,
        sources: list[dict[str, Any]],
        provenance: str,
        verification: str,
    ) -> dict[str, Any]:
        is_experience = payload["schema_version"] == "specialist-experience/1"
        scope = "specialist" if is_experience else payload["scope"]
        role = str(payload.get("specialist_role") or "")
        attributes = payload.get("attributes") or {}
        entity = "SpecialistExperience" if is_experience else payload["entity_type"]
        content = payload["lesson"] if is_experience else payload["content"]
        scalar = bool(attributes.get("field") and attributes.get("subject_ref"))
        canonical = (
            stable_id(entity, attributes["subject_ref"], attributes["field"])
            if scalar
            else stable_id(entity, _normalized(content))
        )
        fingerprint = stable_id({k: v for k, v in payload.items() if k not in {"extractor_id", "candidate_id"}})
        evidence_keys = sorted({str(s["_evidence_key"]) for s in sources})
        with self.ledger.transaction() as db:
            prior_alias = db.execute(
                "SELECT record_id,fingerprint FROM memory_knowledge_aliases "
                "WHERE owner_id=? AND business_id=? AND alias=?",
                (context.owner_id, context.business_id, alias),
            ).fetchone()
            if prior_alias:
                if prior_alias["fingerprint"] != fingerprint:
                    raise MemoryError("candidate_idempotency_conflict")
                record_id = str(prior_alias["record_id"])
            else:
                current = db.execute(
                    "SELECT * FROM memory_knowledge WHERE owner_id=? AND business_id=? AND scope=? AND role=? "
                    "AND canonical_id=? AND superseded_by IS NULL ORDER BY effective DESC,revision DESC LIMIT 1",
                    (context.owner_id, context.business_id, scope, role, canonical),
                ).fetchone()
                current_payload = json.loads(current["payload_json"]) if current else {}
                if current:
                    exclusions = self.source_exclusions(context, current_payload["source_event_ids"])
                    if exclusions:
                        if any(item["reason"] != "operator_canary" for item in exclusions):
                            raise MemoryError("non_business_source_not_admissible")
                        # A fresh authentic claim must not merge its evidence into
                        # a QA-supported row. Preserve that row for audit instead.
                        current, current_payload = None, {}
                same_value = current is not None and (
                    scalar
                    and (current_payload.get("attributes") or {}).get("value") == attributes.get("value")
                    or not scalar
                )
                if current and same_value:
                    record_id = str(current["record_id"])
                    union = sorted(set(json.loads(current["evidence_keys_json"])) | set(evidence_keys))
                    stored = json.loads(current["payload_json"])
                    stored["source_event_ids"] = sorted(
                        set(stored["source_event_ids"]) | set(payload["source_event_ids"])
                    )
                    db.execute(
                        "UPDATE memory_knowledge SET evidence_keys_json=?,evidence_count=?,payload_json=?,"
                        "projection_status='pending' WHERE record_id=?",
                        (_canonical(union), len(union), _canonical(stored), record_id),
                    )
                else:
                    effective = payload.get("validation_state", "confirmed") not in {
                        "pending_conflict",
                        "rejected",
                        "superseded",
                    }
                    target_id = payload.get("supersedes_id") or payload.get("contradicts_id")
                    prior = current if current and current["effective"] else None
                    if target_id:
                        prior = db.execute(
                            "SELECT k.* FROM memory_knowledge k JOIN memory_knowledge_aliases a USING(record_id) "
                            "WHERE a.owner_id=? AND a.business_id=? AND a.alias=? AND k.scope=? AND k.role=?",
                            (context.owner_id, context.business_id, target_id, scope, role),
                        ).fetchone()
                        if prior is None or prior["superseded_by"]:
                            raise MemoryError("replacement_target_not_current_in_scope")
                    if prior is not None:
                        old = json.loads(prior["payload_json"])
                        if old.get("entity_type") != payload.get("entity_type"):
                            raise MemoryError("replacement_target_incompatible")
                        owner_correction = provenance in {Provenance.OWNER_SAID.value, Provenance.OWNER_DECIDED.value}
                        field_kind = self._field_kind(payload)
                        can_replace = not payload.get("contradicts_id") and (
                            payload.get("validation_state") == "confirmed"
                            and owner_correction
                            and field_kind != "measured"
                            or provenance == Provenance.PLATFORM.value
                            and field_kind == "measured"
                            or old.get("validation_state") != "confirmed"
                            and not payload.get("contradicts_id")
                        )
                        if not can_replace:
                            effective = False
                            payload = {
                                **payload,
                                "validation_state": "pending_conflict" if owner_correction else "proposed",
                                "contradicts_id": target_id or prior["record_id"],
                                "supersedes_id": None,
                            }
                        else:
                            payload = {**payload, "supersedes_id": target_id or prior["record_id"]}
                    revision = int(
                        db.execute(
                            "SELECT COALESCE(MAX(revision),0)+1 FROM memory_knowledge "
                            "WHERE owner_id=? AND business_id=? "
                            "AND scope=? AND role=? AND canonical_id=?",
                            (context.owner_id, context.business_id, scope, role, canonical),
                        ).fetchone()[0]
                    )
                    record_id = stable_id("typed-memory", context.owner_id, context.business_id, scope, role, alias)
                    db.execute(
                        "INSERT INTO memory_knowledge(record_id,owner_id,business_id,scope,role,canonical_id,"
                        "revision,payload_json,provenance,verification,evidence_keys_json,evidence_count,effective,"
                        "recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            record_id,
                            context.owner_id,
                            context.business_id,
                            scope,
                            role,
                            canonical,
                            revision,
                            _canonical(payload),
                            provenance,
                            verification,
                            _canonical(evidence_keys),
                            len(evidence_keys),
                            int(effective),
                            now(),
                        ),
                    )
                    if prior is not None and effective:
                        db.execute(
                            "UPDATE memory_knowledge SET effective=0,superseded_by=?,projection_status='pending' "
                            "WHERE record_id=?",
                            (record_id, prior["record_id"]),
                        )
                db.execute(
                    "INSERT INTO memory_knowledge_aliases VALUES(?,?,?,?,?)",
                    (
                        context.owner_id,
                        context.business_id,
                        alias,
                        record_id,
                        fingerprint,
                    ),
                )
                db.execute(
                    "INSERT OR IGNORE INTO memory_knowledge_aliases VALUES(?,?,?,?,?)",
                    (
                        context.owner_id,
                        context.business_id,
                        record_id,
                        record_id,
                        fingerprint,
                    ),
                )
        # A projection failure leaves the committed row pending. The caller may
        # retry this same candidate without generating another inference.
        self.reconcile(context)
        return self.get(context, alias)

    @staticmethod
    def _field_kind(payload: dict[str, Any]) -> str:
        field = (payload.get("attributes") or {}).get("field")
        try:
            return base().field_kind(payload["entity_type"], str(field))
        except KeyError:
            return "descriptive"

    def get(self, context: MemoryContext, record_ref: str) -> dict[str, Any]:
        with closing(self.ledger.connect()) as db:
            row = db.execute(
                "SELECT k.* FROM memory_knowledge k JOIN memory_knowledge_aliases a USING(record_id) "
                "WHERE a.owner_id=? AND a.business_id=? AND a.alias=? AND k.owner_id=? AND k.business_id=?",
                (context.owner_id, context.business_id, record_ref, context.owner_id, context.business_id),
            ).fetchone()
        if row is None:
            raise MemoryError("knowledge_not_found_in_business")
        if row["scope"] == "specialist" and context.actor_role not in (row["role"], "curador"):
            raise MemoryError("private_experience_role_mismatch")
        return self._record(dict(row))

    @staticmethod
    def _record(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "record_id": row["record_id"],
            "payload": json.loads(row["payload_json"]),
            "provenance": row["provenance"],
            "verification": row["verification"],
            "evidence_count": row["evidence_count"],
            "revision": row["revision"],
            "effective": bool(row["effective"]),
            "superseded_by": row["superseded_by"],
            "projection_status": row["projection_status"],
        }

    def current(
        self, context: MemoryContext, *, include_proposals: bool = True, limit: int = 100
    ) -> list[dict[str, Any]]:
        with closing(self.ledger.connect()) as db:
            rows = db.execute(
                "SELECT * FROM memory_knowledge WHERE owner_id=? AND business_id=? AND effective=1 "
                "AND (scope<>'specialist' OR role=?) ORDER BY recorded_at DESC",
                (context.owner_id, context.business_id, context.actor_role),
            )
            records = []
            for row in rows:
                record = self._record(dict(row))
                if self.source_exclusions(context, record["payload"]["source_event_ids"]):
                    continue
                records.append(record)
                if len(records) >= max(1, min(limit, 200)):
                    break
        return [r for r in records if include_proposals or r["payload"].get("validation_state") == "confirmed"]

    def reconcile(self, context: MemoryContext, *, limit: int = 100) -> int:
        with closing(self.ledger.connect()) as db:
            rows = db.execute(
                "SELECT * FROM memory_knowledge WHERE owner_id=? AND business_id=? "
                "AND projection_status='pending' ORDER BY recorded_at LIMIT ?",
                (context.owner_id, context.business_id, max(1, min(limit, 500))),
            ).fetchall()
        for row in rows:
            self._project(MemoryContext(context.owner_id, context.business_id), dict(row))
            with self.ledger.transaction() as db:
                db.execute(
                    "UPDATE memory_knowledge SET projection_status='complete' WHERE record_id=? "
                    "AND payload_json=? AND evidence_keys_json=? AND superseded_by IS ?",
                    (row["record_id"], row["payload_json"], row["evidence_keys_json"], row["superseded_by"]),
                )
        return len(rows)

    def _project(self, context: MemoryContext, row: dict[str, Any]) -> None:
        payload, group = json.loads(row["payload_json"]), group_id(context.business_id)
        experience = payload["schema_version"] == "specialist-experience/1"
        if payload.get("validation_state") == "rejected":
            return
        record_uuid = str(uuid.UUID(row["record_id"]))
        state = payload.get("validation_state")
        verification = row["verification"]
        if row["superseded_by"] or state == "superseded":
            verification = VerificationState.CONTRADICTED.value
        elif state in {"proposed", "pending_conflict"}:
            verification = VerificationState.PROPOSED.value
        self.store.upsert_node(
            group,
            Node(
                uuid=record_uuid,
                type_name="SpecialistExperience" if experience else payload["entity_type"],
                name=(payload["lesson"] if experience else payload["content"])[:80],
                summary=(payload["lesson"] if experience else payload["content"])[:8000],
                provenance=row["provenance"],
                verification=verification,
                created_at=row["recorded_at"],
                attributes={
                    **(payload if experience else payload["attributes"]),
                    "scope": row["scope"],
                    "role": row["role"],
                    "evidence_count": row["evidence_count"],
                    "revision_id": row["record_id"],
                    "valid_from": payload["valid_from"],
                    "valid_to": payload["valid_until"],
                    "stage": "superseded" if row["superseded_by"] else state or "observed",
                },
            ),
        )
        for source_id in payload["source_event_ids"]:
            source = self.source(context, source_id)
            evidence_uuid = str(uuid.UUID(stable_id("memory-evidence", source["_evidence_key"])))
            self.store.upsert_node(
                group,
                Node(
                    uuid=evidence_uuid,
                    type_name="Evidence",
                    name=f"Source: {source['source_kind']}",
                    provenance=row["provenance"],
                    verification=VerificationState.OBSERVED.value,
                    attributes={
                        "source_event_id": source["event_id"],
                        "source_uri": (source["refs"] or [source_id])[0],
                        "source_kind": source["source_kind"],
                        "sha256": source["content_sha256"],
                    },
                ),
            )
            self.store.upsert_edge(
                group,
                Edge(
                    record_uuid,
                    evidence_uuid,
                    "EVIDENCED_BY",
                    provenance=row["provenance"],
                    valid_at=payload["valid_from"],
                ),
            )
        entity = "SpecialistExperience" if experience else payload["entity_type"]
        if base().permits_relation(entity, "ABOUT", "Business"):
            business_nodes = [node for node in self.store.nodes(group, 500) if node.type_name == "Business"]
            if len(business_nodes) == 1:
                self.store.upsert_edge(
                    group,
                    Edge(
                        record_uuid,
                        business_nodes[0].uuid,
                        "ABOUT",
                        provenance=row["provenance"],
                        valid_at=payload["valid_from"],
                    ),
                )
        parent_ref = (payload.get("attributes") or {}).get("derived_from_ref")
        if parent_ref:
            parent = self.get(context, parent_ref)
            self.store.upsert_edge(
                group,
                Edge(
                    record_uuid,
                    str(uuid.UUID(parent["record_id"])),
                    "DERIVED_FROM",
                    provenance=row["provenance"],
                    valid_at=payload["valid_from"],
                ),
            )
        for relation, target_ref in (
            ("SUPERSEDES", payload.get("supersedes_id")),
            ("CONTRADICTS", payload.get("contradicts_id")),
        ):
            if target_ref:
                target = self.get(context, target_ref)
                self.store.upsert_edge(
                    group,
                    Edge(
                        record_uuid,
                        str(uuid.UUID(target["record_id"])),
                        relation,
                        provenance=row["provenance"],
                        valid_at=payload["valid_from"],
                    ),
                )

    def put_goal(self, context: MemoryContext, goal: dict[str, Any]) -> dict[str, Any]:
        validate_contract("goal-state", goal)
        _bound(context, goal)
        sources = self._sources(context, goal["source_event_ids"])
        if goal["origin"] == "owner_confirmed":
            if not any(s["source_kind"] == "owner_message" for s in sources):
                raise MemoryError("goal_confirmation_requires_owner_source")
        elif not any(s["source_kind"] in {"owner_message", "api_observation"} for s in sources):
            raise MemoryError("goal_proposal_requires_business_context")
        if goal["state"] in {"waiting", "blocked"} and not (
            goal["blockers"] or goal["next_condition"] or goal["next_review_at"]
        ):
            raise MemoryError("goal_wait_requires_condition")
        with self.ledger.transaction() as db:
            row = db.execute(
                "SELECT * FROM memory_goals WHERE owner_id=? AND business_id=? AND goal_id=? "
                "ORDER BY revision DESC LIMIT 1",
                (context.owner_id, context.business_id, goal["goal_id"]),
            ).fetchone()
            if row is not None and row["revision"] == goal["revision"] and row["payload_json"] == _canonical(goal):
                return goal
            if goal["revision"] != (int(row["revision"]) + 1 if row else 1):
                raise MemoryError("goal_revision_conflict")
            db.execute(
                "INSERT INTO memory_goals VALUES(?,?,?,?,?,?)",
                (
                    context.owner_id,
                    context.business_id,
                    goal["goal_id"],
                    goal["revision"],
                    _canonical(goal),
                    now(),
                ),
            )
        return goal

    def goal(self, context: MemoryContext, goal_id: str | None = None) -> dict[str, Any] | None:
        with closing(self.ledger.connect()) as db:
            row = db.execute(
                "SELECT payload_json FROM memory_goals WHERE owner_id=? AND business_id=? "
                "AND (? IS NULL OR goal_id=?) ORDER BY recorded_at DESC,revision DESC LIMIT 1",
                (context.owner_id, context.business_id, goal_id, goal_id),
            ).fetchone()
        if not row:
            return None
        payload = dict(json.loads(row["payload_json"]))
        # A legacy payload without explicit origin is read conservatively; do
        # not turn historical reasoning into an owner confirmation.
        payload.setdefault("origin", "assistant_proposed")
        return payload
