"""Read-only bridge from the authenticated structured bootstrap snapshot.

Never upgrades old OwnerNotes or model-authored graph nodes to verified facts.
An API-reported field is evidence of what SaleADS reported at that snapshot,
not approval for spend or proof that an advertising claim is true.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from saleads_brain.knowledge import MemoryContext, MemoryError, MemoryWriter, validate_contract
from saleads_brain.ledger import now, stable_id
from saleads_brain.seed import BOOTSTRAP_SCHEMAS

PROJECTION_VERSION = "bootstrap-view/2"


class BootstrapMemory:
    def __init__(self, memory: MemoryWriter, path: Path, owner_id: str) -> None:
        self.memory, self.path, self.owner_id = memory, path, owner_id

    def entries(self, context: MemoryContext, current: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if context.owner_id != self.owner_id:
            raise MemoryError("memory_binding_mismatch")
        if not self.path.is_file():
            return []
        raw = self.path.read_bytes()
        try:
            snapshot = json.loads(raw)
        except ValueError as error:
            raise MemoryError("bootstrap_snapshot_invalid") from error
        if not isinstance(snapshot, dict) or snapshot.get("schema") != "saleads-seed/1":
            raise MemoryError("bootstrap_snapshot_invalid")
        businesses = [
            item
            for item in snapshot.get("businesses", [])
            if isinstance(item, dict) and item.get("business_id") == context.business_id
        ]
        if len(businesses) != 1 or businesses[0].get("schema_version") not in BOOTSTRAP_SCHEMAS:
            raise MemoryError("bootstrap_business_not_registered")
        business = businesses[0]
        facts = (business.get("context") or {}).get("facts") or {}
        if not isinstance(facts, dict):
            raise MemoryError("bootstrap_facts_invalid")
        fields: list[tuple[str, str, str, object, bool]] = []
        labels: dict[str, str] = {}

        def add(entity: str, subject: str, field: str, value: object, always: bool = False) -> None:
            if value is None or value == "" or isinstance(value, (dict, list, bool)):
                return
            if isinstance(value, str) and len(value) > 2000:
                return  # Do not present a cropped field as a complete fact.
            if not isinstance(value, (str, int, float)):
                return
            fields.append((entity, subject, field, value, always))

        identity = facts.get("business") or {}
        if isinstance(identity, dict):
            for source_field, target in (
                ("name", "brand_name"),
                ("description", "description"),
                ("industry", "industry_code"),
                ("website", "website"),
                ("value_proposition", "positioning"),
            ):
                add("Business", context.business_id, target, identity.get(source_field), always=True)
        brand = facts.get("brand") or {}
        if isinstance(brand, dict):
            voice = brand.get("tone") or brand.get("voice")
            if isinstance(voice, list) and all(isinstance(item, str) for item in voice):
                voice = " | ".join(item.strip() for item in voice if item.strip())
            add("Business", context.business_id, "voice_notes", voice, always=True)
        audience = facts.get("audience") or {}
        if isinstance(audience, dict):
            add("Segment", "business-audience", "description", audience.get("description"))
        marketing = facts.get("marketing") or {}
        if isinstance(marketing, dict):
            goals = marketing.get("goals") or []
            if isinstance(goals, str):
                goals = [goals]
            if isinstance(goals, list):
                for index, goal in enumerate(goals):
                    add("Goal", f"business-goal:{index}", "statement", goal, always=True)
        for kind, key in (("product", "products"), ("service", "services")):
            items = facts.get(key) or []
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                identifier = item.get("product_id") if kind == "product" else item.get("id")
                identifier = identifier or item.get("id")
                if not isinstance(identifier, str) or not identifier:
                    continue
                subject = kind + ":" + identifier
                if isinstance(item.get("name"), str) and len(item["name"]) <= 2000:
                    labels[subject] = item["name"]
                # Name is represented as the descriptive product/service value;
                # existing vocabulary has no separate public product-name field.
                add("ProductOrService", subject, "description", item.get("description") or item.get("name"))
                add("ProductOrService", subject, "offering_kind", kind)
                add("Offer", subject, "price", item.get("price"))
                add("Offer", subject, "currency", item.get("currency"))
        shadowed = {
            (item["payload"].get("entity_type"), attrs.get("subject_ref"), attrs.get("field"))
            for item in current
            if item["payload"].get("validation_state") == "confirmed"
            and (attrs := item["payload"].get("attributes") or {}).get("field")
        }
        sha = hashlib.sha256(raw).hexdigest()
        # All supported fields remain retrievable. Source envelopes are bounded
        # chunks of one snapshot, not separate independent observations.
        original: list[dict[str, Any]] = [
            {
                "entity_type": entity,
                "subject_ref": subject,
                "field": field,
                "value": value,
                "always_include": always,
                "source_label": labels.get(subject),
            }
            for entity, subject, field, value, always in fields
        ]
        chunks: list[list[dict[str, Any]]] = [[]]
        for item in original:
            if chunks[-1] and len(json.dumps([*chunks[-1], item], ensure_ascii=False)) > 20_000:
                chunks.append([])
            chunks[-1].append(item)
        timestamp = now()
        source_for_field: dict[tuple[str, str, str], tuple[str, int]] = {}
        first_source = ""
        for index, chunk in enumerate(chunks):
            content = json.dumps(
                {
                    "schema": business["schema_version"],
                    "projection_schema": PROJECTION_VERSION,
                    "snapshot_sha256": sha,
                    "snapshot_generated_at": business.get("generated_at"),
                    "projection_chunk_index": index,
                    "projection_chunk_count": len(chunks),
                    "source_field_count": len(fields),
                    "included_field_count": len(chunk),
                    "fields": chunk,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            source_id = "bootstrap-" + stable_id(context.business_id, sha, PROJECTION_VERSION, index)
            event = {
                "schema_version": "source-event/1",
                "event_id": source_id,
                "owner_id": context.owner_id,
                "business_id": context.business_id,
                "source_kind": "api_observation",
                "source_id": "business-bootstrap-" + context.business_id,
                "source_version": sha + f":view-2:chunk-{index}",
                "author": {"kind": "api", "id": "saleads-business-bootstrap"},
                "extractor_id": "bootstrap-bridge",
                "occurred_at": timestamp,
                "recorded_at": timestamp,
                "content": content,
                "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
                "refs": ["mcp-tool:saleads_get_business_bootstrap", "seed-snapshot:" + sha],
                "purpose": "business_work",
                "native_task_id": None,
                "native_run_id": None,
            }
            self.memory.register_source(context, event)
            first_source = first_source or source_id
            for item in chunk:
                source_for_field[(item["entity_type"], item["subject_ref"], item["field"])] = (source_id, index)
        persisted = self.memory.source(context, first_source)
        valid_from = persisted["occurred_at"]
        generated = business.get("generated_at")
        if isinstance(generated, str):
            try:
                parsed = datetime.fromisoformat(generated.replace("Z", "+00:00"))
                if parsed.tzinfo is not None:
                    valid_from = generated
            except ValueError:
                pass  # The raw API field remains in source metadata, never a fabricated timestamp.
        result = []
        for item in original:
            field_key = (item["entity_type"], item["subject_ref"], item["field"])
            if field_key in shadowed:
                continue
            source_id, chunk_index = source_for_field[field_key]
            entry_id = "seed-" + stable_id(
                sha, PROJECTION_VERSION, context.business_id, item["entity_type"], item["subject_ref"], item["field"]
            )
            payload = {
                "schema_version": "knowledge-candidate/1",
                "candidate_id": entry_id,
                "owner_id": context.owner_id,
                "business_id": context.business_id,
                "entity_type": item["entity_type"],
                "content": json.dumps({item["field"]: item["value"]}, ensure_ascii=False, sort_keys=True),
                "attributes": {
                    "subject_ref": item["subject_ref"],
                    "field": item["field"],
                    "value": item["value"],
                    "source_origin": "saleads_bootstrap",
                    "source_projection": PROJECTION_VERSION,
                    "source_label": item["source_label"],
                    "snapshot_sha256": sha,
                    "snapshot_generated_at": business.get("generated_at"),
                    "projection_chunk_index": chunk_index,
                    "projection_chunk_count": len(chunks),
                    "source_status": "reported_by_api",
                },
                "source_event_ids": [source_id],
                "scope": "business",
                "specialist_role": None,
                "extractor_id": "bootstrap-bridge",
                "epistemic": "observed",
                "validation_state": "confirmed",
                "valid_from": valid_from,
                "valid_until": None,
                "supersedes_id": None,
                "contradicts_id": None,
            }
            validate_contract("knowledge-candidate", payload)
            result.append(
                {
                    "record_id": entry_id,
                    "payload": payload,
                    "revision": 1,
                    "effective": True,
                    "always_include": item["always_include"],
                    "provenance": "saleads_seed",
                }
            )
        return result
