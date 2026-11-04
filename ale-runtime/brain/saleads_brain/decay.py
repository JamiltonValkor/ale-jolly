"""decay: lo aprendido que no se vuelve a confirmar pierde confianza (MLB-011).

Un aprendizaje vigente sin evidencia nueva en 60 días baja un nivel de
confianza (alta → media → baja). Nunca se borra ni se reemplaza: queda visible
con su fecha. La fecha de referencia es `as_of` (el simulador) o la real.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from saleads_brain.graph import GraphStore, Node
from saleads_brain.snapshot import business_id_of

STALE_AFTER = timedelta(days=60)
LOWER = {"alta": "media", "media": "baja"}


def _when(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def decay(store: GraphStore, as_of: str | None = None) -> dict[str, Any]:
    now = _when(as_of) if as_of else datetime.now(UTC)
    if now is None:
        raise ValueError("as_of_invalido")
    lowered = 0
    for group in store.groups():
        if business_id_of(group) is None:
            continue
        for node in store.nodes(group, 2000):
            if node.type_name != "Learning" or node.attributes.get("stage") != "vigente":
                continue
            confidence = node.attributes.get("confidence")
            last = _when(
                node.attributes.get("last_evidence_at") or node.attributes.get("learned_at") or node.created_at
            )
            decayed = _when(node.attributes.get("decayed_at"))
            reference = max(d for d in (last, decayed) if d is not None) if (last or decayed) else None
            if confidence not in LOWER or reference is None or now - reference < STALE_AFTER:
                continue
            store.upsert_node(
                group,
                Node(
                    uuid=node.uuid,
                    type_name=node.type_name,
                    name=node.name,
                    summary=node.summary,
                    provenance=node.provenance,
                    verification=node.verification,
                    created_at=node.created_at,
                    attributes={**node.attributes, "confidence": LOWER[confidence], "decayed_at": now.isoformat()},
                    mentions=node.mentions,
                ),
            )
            lowered += 1
    return {"lowered": lowered}
