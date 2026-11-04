"""Relevant, bounded memory capsules; no global files or model calls."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from saleads_brain import search
from saleads_brain.baseline import BootstrapMemory
from saleads_brain.knowledge import MemoryContext, MemoryWriter


@dataclass(frozen=True, slots=True)
class _SearchRecord:
    record: dict[str, Any]
    name: str
    summary: str
    created_at: str


class MemoryRecall:
    def __init__(self, memory: MemoryWriter, baseline: BootstrapMemory | None = None) -> None:
        self.memory, self.baseline = memory, baseline

    def retrieve(
        self,
        context: MemoryContext,
        query: str,
        *,
        at: str | None = None,
        max_experiences: int = 3,
        max_knowledge: int = 12,
        max_chars: int = 6000,
    ) -> dict[str, Any]:
        instant = datetime.fromisoformat(at.replace("Z", "+00:00")) if at else datetime.now(UTC)
        candidates: list[_SearchRecord] = []
        excluded: list[dict[str, str]] = []
        current = self.memory.current(context, limit=200)
        baseline = self.baseline.entries(context, current) if self.baseline else []
        for record in [*current, *baseline]:
            payload = record["payload"]
            start = datetime.fromisoformat(payload["valid_from"].replace("Z", "+00:00"))
            end = (
                datetime.fromisoformat(payload["valid_until"].replace("Z", "+00:00"))
                if payload["valid_until"]
                else None
            )
            if start > instant or end and instant >= end:
                excluded.append({"record_id": record["record_id"], "reason": "outside_validity"})
                continue
            if payload["schema_version"] == "specialist-experience/1":
                name, summary = payload["lesson"], " ".join(
                    payload[key] for key in ("method", "applicability", "correction", "observed_result")
                )
            else:
                name, summary = payload["content"], json.dumps(payload["attributes"], ensure_ascii=False)
            candidates.append(_SearchRecord(record, name, summary, payload["valid_from"]))
        ranked = search.rank(candidates, search.terms(query), len(candidates))
        current_ids = {record["record_id"] for record in current}
        standing = [
            item
            for item in candidates
            if item.record["record_id"] in current_ids and self._standing_constraint(item.record)
        ]
        standing_ids = {item.record["record_id"] for item in standing}
        prioritized = standing
        current_hits = [
            item
            for item in ranked
            if item.record["record_id"] in current_ids and item.record["record_id"] not in standing_ids
        ]
        # Own-role experience guides the work before ordinary business context;
        # confirmed constraints retain precedence. Stable order preserves BM25
        # ranking within both groups, after the same scope/validity filters.
        prioritized.extend(
            sorted(current_hits, key=lambda item: item.record["payload"]["schema_version"] != "specialist-experience/1")
        )
        baseline_always = [item for item in candidates if item.record.get("always_include")]

        def baseline_priority(item: _SearchRecord) -> int:
            payload = item.record["payload"]
            field = payload["attributes"].get("field")
            if payload["entity_type"] == "Business" and field == "brand_name":
                return 0
            if payload["entity_type"] == "Goal":
                return 1
            return {"positioning": 2, "voice_notes": 3}.get(str(field), 4)

        identities = [item for item in baseline_always if baseline_priority(item) == 0]
        identity_ids = {item.record["record_id"] for item in identities}
        prioritized.extend(identities)
        baseline_hits = [
            item
            for item in ranked
            if item.record["record_id"] not in current_ids and item.record["record_id"] not in identity_ids
        ]
        prioritized.extend(baseline_hits)
        baseline_hit_ids = {item.record["record_id"] for item in baseline_hits}
        prioritized.extend(
            item
            for item in sorted(baseline_always, key=baseline_priority)
            if item.record["record_id"] not in identity_ids and item.record["record_id"] not in baseline_hit_ids
        )
        ranked = prioritized
        experiences: list[dict[str, Any]] = []
        knowledge: list[dict[str, Any]] = []
        versions: dict[str, int] = {}
        refs: list[str] = []
        entry_ids: dict[str, str] = {}
        size, truncated = 0, False
        for hit in ranked:
            record, payload = hit.record, hit.record["payload"]
            is_experience = payload["schema_version"] == "specialist-experience/1"
            target = experiences if is_experience else knowledge
            maximum = min(3, max(0, max_experiences)) if is_experience else max(0, min(20, max_knowledge))
            if len(target) >= maximum:
                truncated = True
                continue
            cost = len(json.dumps(payload, ensure_ascii=False))
            if size + cost > max(0, min(8000, max_chars)):
                truncated = True
                continue
            size += cost
            target.append(payload)
            versions[record["record_id"]] = record["revision"]
            entry_ids[record["record_id"]] = payload.get("candidate_id") or payload["experience_id"]
            refs.extend(payload["source_event_ids"])
        matched = {hit.record["record_id"] for hit in ranked}
        excluded.extend(
            {"record_id": item.record["record_id"], "reason": "not_relevant"}
            for item in candidates
            if item.record["record_id"] not in matched
        )
        return {
            "knowledge": knowledge,
            "experiences": experiences,
            "versions": versions,
            "entry_ids": entry_ids,
            "refs": sorted(set(refs)),
            "truncated": truncated,
            "excluded": excluded,
            "size_chars": size,
        }

    @staticmethod
    def _standing_constraint(record: dict[str, Any]) -> bool:
        """Confirmed decisions and operational constraints survive query wording.

        A declared field identifies the owner's authority over a fact, not a
        query-independent constraint. Ordinary facts retain their validation and
        provenance and use relevance ranking. Scope/validity are already filtered.
        """
        payload = record["payload"]
        if payload.get("validation_state") != "confirmed" or payload.get("schema_version") != "knowledge-candidate/1":
            return False
        return payload["entity_type"] in {"Decision", "OperationalConstraint"}
