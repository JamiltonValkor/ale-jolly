"""Hechos tipados del dueño (AAB-019).

El cerebro guardaba enunciados; con ellos no se puede escribir de forma determinista «audiencia.ideal_client = X» en
BI ni probar que una corrección «la dijo el dueño». Este módulo valida un hecho contra el vocabulario cerrado
(`contracts/saleads-brain-fact-paths-1.json`, fuente de verdad que BI vendoriza), lo normaliza (recorta, quita
duplicados y datos personales) y decide si se vuelve el vigente con la misma precedencia del cerebro: lo inferido
nunca reemplaza lo que dijo o decidió el dueño.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any

from saleads_brain.ledger import Ledger
from saleads_brain.privacy import redact, redact_people
from saleads_brain.provenance import Claim, Provenance, resolve

VOCABULARY_FILE = "saleads-brain-fact-paths-1.json"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
# Procedencia de entrada → la del cerebro. En la foto, `inferred` vuelve a salir como `agent_inferred`.
_INPUT_PROVENANCE = {
    "owner_said": Provenance.OWNER_SAID,
    "owner_decided": Provenance.OWNER_DECIDED,
    "agent_inferred": Provenance.INFERRED,
    "platform": Provenance.PLATFORM,
}
MAX_EVIDENCE = 500


class FactError(ValueError):
    """Rechazo de un hecho, con un código estable que ve el agente."""


@dataclass(frozen=True, slots=True)
class FactPath:
    path: str
    section: str
    value_type: str
    max_len: int
    max_items: int | None
    enum: tuple[str, ...] | None
    allowed_provenance: tuple[str, ...]
    requires_offering_ref: bool


@cache
def vocabulary() -> dict[str, FactPath]:
    raw = json.loads(resources.files("saleads_brain").joinpath("contracts", VOCABULARY_FILE).read_text("utf-8"))
    return {
        entry["path"]: FactPath(
            path=entry["path"],
            section=entry["section"],
            value_type=entry["value_type"],
            max_len=int(entry["max_len"]),
            max_items=entry.get("max_items"),
            enum=tuple(entry["enum"]) if entry.get("enum") else None,
            allowed_provenance=tuple(entry["allowed_provenance"]),
            requires_offering_ref=bool(entry.get("requires_offering_ref")),
        )
        for entry in raw["paths"]
    }


def _clean(text: str, keep: list[str]) -> str:
    return redact_people(redact(" ".join(text.split())), keep)


def normalize(spec: FactPath, value: object, keep: list[str]) -> str | list[str]:
    if spec.value_type == "string":
        if not isinstance(value, str) or not value.strip():
            raise FactError("value_type")
        text = _clean(value, keep)
        if len(text) > spec.max_len:
            raise FactError("value_too_long")
        return text
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise FactError("value_type")
    items: list[str] = []
    for item in value:
        text = _clean(item, keep)
        if spec.enum:
            text = text.lower()
        if not text or text in items:
            continue
        if len(text) > spec.max_len:
            raise FactError("value_too_long")
        if spec.enum and text not in spec.enum:
            raise FactError("value_not_in_enum")
        items.append(text)
    if not items:
        raise FactError("value_type")
    if spec.max_items is not None and len(items) > spec.max_items:
        raise FactError("value_too_long")
    return items


def snapshot_provenance(provenance: str) -> str:
    """En la foto v3 y en knowledge-sync (C-29): `inferred` sale como `agent_inferred`."""
    return "agent_inferred" if provenance == Provenance.INFERRED else provenance


def record_fact(
    ledger: Ledger,
    *,
    business_id: str,
    path: str,
    value: object,
    provenance: str,
    evidence: str,
    observed_at: str,
    offering_ref: str | None = None,
    keep_names: list[str] | None = None,
) -> dict[str, Any]:
    """Guarda una revisión del hecho; responde si quedó vigente (`applied`) y por qué no, si no."""
    spec = vocabulary().get(path)
    if spec is None:
        raise FactError("path_not_in_vocabulary")
    if spec.requires_offering_ref != bool(offering_ref):
        raise FactError("offering_ref_required" if spec.requires_offering_ref else "offering_ref_not_allowed")
    if offering_ref is not None and not UUID.match(offering_ref):
        raise FactError("offering_ref_invalid")
    if provenance not in _INPUT_PROVENANCE or provenance not in spec.allowed_provenance:
        raise FactError("provenance_not_allowed_for_path")
    if not evidence or not evidence.strip():
        raise FactError("falta:evidence")
    keep = keep_names or []
    clean = normalize(spec, value, keep)
    incoming = Claim(clean, _INPUT_PROVENANCE[provenance])
    current = ledger.current_fact(business_id, path, offering_ref)
    current_claim = Claim(current["value"], Provenance(current["provenance"])) if current else None
    if current is not None and current["value"] == clean:
        return {
            "accepted": True, "applied": False, "noop": True, "fact_revision_id": current["revision_id"], "path": path,
            "provenance": snapshot_provenance(current["provenance"]),
        }
    decision = resolve("declared", current_claim, incoming)
    applied = decision.winner is incoming
    revision = ledger.add_fact_revision(
        business_id=business_id, path=path, offering_ref=offering_ref, value=clean,
        provenance=incoming.provenance.value, evidence=_clean(evidence, keep)[:MAX_EVIDENCE], observed_at=observed_at,
        applied=applied, reason=None if applied else decision.reason,
    )
    response: dict[str, Any] = {
        "accepted": True, "applied": applied, "fact_revision_id": revision["revision_id"], "path": path,
        "provenance": snapshot_provenance(incoming.provenance.value),
    }
    if not applied:
        response["reason"] = decision.reason
    return response


def snapshot_facts(ledger: Ledger, business_id: str, limit: int = 200) -> list[dict[str, Any]]:
    """Hechos vigentes para la foto v3: forma exacta de `knowledge-sync.v1.facts[]` (C-29)."""
    return [
        {
            "path": fact["path"], "offering_ref": fact["offering_ref"], "value": fact["value"],
            "provenance": snapshot_provenance(fact["provenance"]), "revision_id": fact["revision_id"],
            "version": fact["version"], "observed_at": fact["observed_at"], "recorded_at": fact["recorded_at"],
        }
        for fact in ledger.current_facts(business_id, limit)
    ]
