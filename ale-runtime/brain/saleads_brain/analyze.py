"""analyze: propone tipos nuevos a partir de lo que se repite sin tipo (gobernanza de ORQA, MLB-011).

Un concepto sin tipo de la ontología se propone como `entity_type` que extiende
un tipo base, elegido por sus relaciones con nodos tipados (los pares declarados
en la ontología). Solo cuenta la evidencia de **episodios distintos**: al menos 3
episodios y 2 fuentes (sesiones). Varias menciones dentro de un mismo episodio no
suman. Lo semántico y sin efecto operativo se activa solo (autonomy_class
semantic_only, operational false) si la gobernanza no ve palabras sensibles
(gasto, publicación, identidad…); lo demás queda como propuesta para el dueño.
Después de activar, se exporta el archivo de tipos aprendidos de ese negocio.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from saleads_brain.graph import GraphStore
from saleads_brain.ledger import Ledger
from saleads_brain.ontology import CORE_TYPES, base
from saleads_brain.snapshot import business_id_of

MIN_EPISODES = 3
MIN_SOURCES = 2


def _parent(store: GraphStore, group: str, uuid: str) -> str | None:
    """Tipo base más probable según los pares declarados de sus relaciones."""
    onto = base()
    votes: Counter[str] = Counter()
    for edge in store.edges_of(group, uuid):
        other_id = edge.target if edge.source == uuid else edge.source
        other = store.node(group, other_id)
        if other is None or other.type_name not in onto.entities:
            continue
        for source, target in onto.edges.get(edge.name, ()):
            candidate = (
                target
                if edge.source == other_id and source == other.type_name
                else (source if edge.target == other_id and target == other.type_name else None)
            )
            if candidate and candidate in onto.entities and candidate not in CORE_TYPES and candidate != "Entity":
                votes[candidate] += 1
    if not votes:
        return None
    return votes.most_common(1)[0][0]


def analyze(store: GraphStore, ledger: Ledger, learned_dir: Path | None = None) -> dict[str, Any]:
    proposed = activated = 0
    for group in store.groups():
        business_id = business_id_of(group)
        if business_id is None:
            continue
        touched = False
        for node in store.nodes(group, 500):
            if node.type_name != "Entity" or not node.name.strip():
                continue
            episodes = store.episodes_of(group, node.uuid)
            distinct = {uuid for uuid, _ in episodes}
            sources = {source for _, source in episodes if source}
            if len(distinct) < MIN_EPISODES or len(sources) < MIN_SOURCES:
                continue
            name = "".join(part.capitalize() for part in node.name.split()[:4] if part.isalnum())[:60]
            if len(name) < 2 or not name[0].isalpha():
                continue
            parent = _parent(store, group, node.uuid)
            refs = [f"episode:{uuid}" for uuid in sorted(distinct)]
            if parent is None:
                ledger.propose_ontology_change(
                    business_id=business_id,
                    proposal_kind="business_concept",
                    name=name,
                    definition=(node.summary or node.name)[:400],
                    schema={"source_node": node.uuid},
                    evidence_refs=refs,
                    proposer_id="saleads:brain-analyze",
                )
                proposed += 1
                continue
            proposal = ledger.propose_ontology_change(
                business_id=business_id,
                proposal_kind="entity_type",
                name=name,
                definition=(node.summary or node.name)[:400],
                schema={
                    "extends": parent,
                    "fields": {},
                    "autonomy_class": "semantic_only",
                    "operational": False,
                    "source_node": node.uuid,
                },
                evidence_refs=refs,
                proposer_id="saleads:brain-analyze",
            )
            proposed += 1
            try:
                ledger.activate_safe_semantic(
                    proposal_id=proposal, note=f"{len(distinct)} episodios, {len(sources)} fuentes"
                )
                activated += 1
                touched = True
            except ValueError:
                pass  # queda propuesto: lo revisa el dueño («Pendiente de confirmar»)
        if touched and learned_dir is not None:
            ledger.export_active_ontology(business_id, learned_dir / f"{business_id}.json")
    return {"proposed": proposed, "activated": activated}
