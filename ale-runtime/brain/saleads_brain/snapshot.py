"""export-snapshot: foto acotada del grafo para «Mi cerebro» (`saleads-explorer-snapshot/2`).

La v2 (MLB-014) suma las familias del loop (bet, verdict), los atributos del
loop por nodo (etapa, confianza, verificación, fechas, reemplazado por, alcance)
y las secciones de «Mi cerebro». El servicio sigue sirviendo la v1 al front
viejo convirtiendo esta foto.

Un solo `.json.gz` por VM con N negocios (el servicio lo parte por negocio).
Hasta 500 nodos por negocio, sin embeddings ni evidencia cruda: tipo, familia,
estado visible, procedencia, menciones y línea de tiempo.
"""

from __future__ import annotations

import gzip
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from saleads_brain.facts import snapshot_facts
from saleads_brain.graph import GraphStore
from saleads_brain.ledger import Ledger
from saleads_brain.ontology import base
from saleads_brain.states import VerificationState, visible_state

SCHEMA = "saleads-explorer-snapshot/3"
MAX_NODES = 500
MAX_EDGES = 2000


def business_id_of(group: str) -> str | None:
    hexa = group.removeprefix("b_")
    if len(hexa) != 32 or any(c not in "0123456789abcdef" for c in hexa):
        return None
    return f"{hexa[:8]}-{hexa[8:12]}-{hexa[12:16]}-{hexa[16:20]}-{hexa[20:]}"


# Procedencia: lista cerrada. Lo que Graphiti extrae de una conversación llega sin
# procedencia o con un valor que inventó el modelo (en el laboratorio: «Medellín, Colombia»).
KNOWN_PROVENANCE = {"saleads_seed", "owner_said", "owner_decided", "platform", "inferred", "inferred_from_platform"}
CONVERSATION = "conversation"
# Los hablantes no son conocimiento del negocio (laboratorio L1-13).
SPEAKERS = {"dueño", "dueña", "dueno", "propietario", "asistente", "assistant", "owner", "usuario", "user"}
RELATION = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def _provenance(value: str) -> str:
    return value if value in KNOWN_PROVENANCE else CONVERSATION


def _state(verification: str, provenance: str) -> str:
    if verification in ("CONTRADICTED", "RETRACTED"):
        return "superseded"
    if provenance in ("inferred", "inferred_from_platform"):
        return "proposed"
    if provenance == CONVERSATION:
        return "observed"
    try:
        return visible_state(VerificationState(verification)).value
    except ValueError:
        return "observed"


def _relation(name: str) -> str:
    """Nombre de relación corto (el modelo a veces devuelve una oración entera)."""
    if RELATION.match(name):
        return name
    words = re.findall(r"[A-Za-z0-9]+", name.upper())[:4]
    return ("_".join(words) or "RELATES_TO")[:64]


def _is_speaker(name: str) -> bool:
    return name.strip().casefold() in SPEAKERS


CONFIDENCE = {"baja", "media", "alta"}
ACTIVE_BET = {"en_plan", "en_prueba", "lanzada"}
IDENTITY_FAMILIES = {"identity", "offer"}
# MCB-009: decisiones y notas del dueño. Sin su cita (o con eco de Ale) quedan inferidas: van a «por confirmar».
OWNER_TYPES = ("Decision", "OwnerNote")
TO_CONFIRM = ("Avatar", "Angle", "Format", *OWNER_TYPES)


def _opt(value: Any, limit: int = 300) -> str | None:
    return str(value)[:limit] if value not in (None, "") else None


def _sections(nodes: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Secciones de «Mi cerebro» (MLB-014): ids de nodos, en el orden de la foto."""
    out: dict[str, list[str]] = {
        k: []
        for k in ("my_business", "active_bets", "learned", "did_not_work", "your_corrections", "to_confirm", "history")
    }
    for n in nodes:
        superseded = n["state"] == "superseded" or n["stage"] == "reemplazado" or n["superseded_by"]
        if superseded:
            out["history"].append(n["id"])
        elif n["type"] == "Bet" and n["stage"] in ACTIVE_BET:
            out["active_bets"].append(n["id"])
        elif n["type"] == "Learning":
            out["learned"].append(n["id"])
        elif (n["type"] == "Bet" and n["stage"] == "perdedora") or (
            n["type"] == "Verdict" and n["outcome"] == "pierde"
        ):
            out["did_not_work"].append(n["id"])
        elif n["type"] in OWNER_TYPES and n["provenance"] in ("owner_said", "owner_decided"):
            out["your_corrections"].append(n["id"])
        elif n["family"] == "learned" or (n["state"] == "proposed" and n["type"] in TO_CONFIRM):
            out["to_confirm"].append(n["id"])
        elif n["family"] in IDENTITY_FAMILIES:
            out["my_business"].append(n["id"])
    return out


def build(store: GraphStore, generated_at: str | None = None, ledger: Ledger | None = None) -> dict[str, Any]:
    onto = base()
    domains = {name: spec.domain for name, spec in onto.entities.items()}
    labels = {name: spec.label_es for name, spec in onto.entities.items()}
    businesses = []
    for group in store.groups():
        business_id = business_id_of(group)
        if business_id is None:
            continue
        nodes = [n for n in store.nodes(group, MAX_NODES)
                 if not _is_speaker(n.name) and n.type_name != "SpecialistExperience"
                 and n.attributes.get("scope") != "specialist"]
        ids = {n.uuid for n in nodes}
        edges = [e for e in store.edges(group, MAX_EDGES) if e.source in ids and e.target in ids]
        # Cuarentena (MLB-011): un nodo sin tipo ni conexión no se muestra como conocimiento.
        linked = {e.source for e in edges} | {e.target for e in edges}
        nodes = [n for n in nodes if n.type_name != "Entity" or n.uuid in linked]
        superseded_by = {e.target: e.source for e in edges if e.name == "SUPERSEDES"}
        view_nodes = [
            {
                "id": n.uuid,
                "type": n.type_name,
                "family": domains.get(n.type_name, "learned" if n.type_name != "Entity" else "other"),
                "label": n.name[:200],
                "summary": n.summary[:500],
                "state": _state(n.verification, _provenance(n.provenance)),
                "provenance": _provenance(n.provenance),
                "mentions": n.mentions,
                "created_at": n.created_at or None,
                "type_label": labels.get(n.type_name, n.type_name)[:64],
                "stage": _opt(n.attributes.get("stage"), 40),
                "confidence": n.attributes.get("confidence") if n.attributes.get("confidence") in CONFIDENCE else None,
                "verification": n.verification[:40],
                "valid_from": _opt(n.attributes.get("valid_from")),
                "learned_at": _opt(n.attributes.get("learned_at")),
                "superseded_by": superseded_by.get(n.uuid),
                "scope": _opt(n.attributes.get("scope")),
                "evidence_count": int(n.attributes["evidence_count"]) if n.attributes.get("evidence_count") else None,
                "outcome": _opt(n.attributes.get("outcome"), 20),
            }
            for n in nodes
        ]
        businesses.append(
            {
                "business_id": business_id,
                "nodes": view_nodes,
                "edges": [
                    {
                        "source": e.source,
                        "target": e.target,
                        "type": _relation(e.name),
                        "fact": e.fact[:300],
                        "provenance": _provenance(e.provenance),
                        "valid_at": e.valid_at,
                        "invalid_at": e.invalid_at,
                    }
                    for e in edges
                ],
                "stats": {"nodes": len(nodes), "edges": len(edges)},
                "sections": _sections(view_nodes),
                # v3 (AAB-019): hechos vigentes del ledger (no del grafo), tope propio de 200, aparte de los 500 nodos.
                "facts": snapshot_facts(ledger, business_id) if ledger is not None else [],
            }
        )
    return {
        "schema": SCHEMA,
        "generated_at": datetime.now(UTC).isoformat() if generated_at is None else generated_at,
        "businesses": businesses,
    }


def write(store: GraphStore, path: Path, ledger: Ledger | None = None) -> dict[str, Any]:
    """Escribe solo si el contenido cambió (el watcher sube por cambio de sha). `written` dice si cambió."""
    snapshot = build(store, generated_at="", ledger=ledger)
    body = json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = gzip.decompress(path.read_bytes()) if path.exists() else b""
    written = previous != body
    if written:
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(body, mtime=0))
        tmp.replace(path)
    return {
        "written": written,
        "businesses": len(snapshot["businesses"]),
        "nodes": sum(b["stats"]["nodes"] for b in snapshot["businesses"]),
    }
