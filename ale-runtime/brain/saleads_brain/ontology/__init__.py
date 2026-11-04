"""Ontología base generada desde `base.yaml` (fuente única).

Expone los modelos pydantic de entidades y relaciones para Graphiti, las listas
por tipo de evento y los tipos aprendidos, que siempre cuelgan de un tipo base.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any, cast

import yaml
from pydantic import BaseModel, ConfigDict, Field, create_model

from saleads_brain.provenance import FieldKind

# Nombres que Graphiti reserva en sus nodos: ningún tipo puede usarlos.
PROTECTED_FIELDS = frozenset(
    {"uuid", "name", "group_id", "labels", "created_at", "name_embedding", "summary", "attributes"}
)
TYPE_NAME = re.compile(r"[A-Z][A-Za-z0-9_]{1,63}")
# Graphiti exige nombres ASCII de identificador para tipos y relaciones (helpers.py:35).
ASCII_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Núcleo del loop (MLB-008/009): solo lo escriben las tools tipadas, nunca la extracción libre.
CORE_TYPES = frozenset({"Bet", "AdSet", "Ad", "Result", "Verdict", "SpecialistExperience"})
SUPPORTED_SCHEMAS = frozenset({"saleads-brain-ontology/1", "saleads-brain-ontology/2"})
FIELD_NAME = re.compile(r"[a-z][a-z0-9_]{1,63}")


class BrainEntity(BaseModel):
    """Base de toda entidad del cerebro.

    `extra="ignore"`: Graphiti valida cada entidad con TODAS las propiedades ya
    guardadas en el nodo (las de la semilla incluidas); rechazarlas tiraba el lote.
    """

    model_config = ConfigDict(extra="ignore")
    canonical_id: str | None = Field(default=None, description="ID estable cuando la fuente lo trae (SaleADS, Meta).")
    source_refs: list[str] | None = None
    # Sin `provenance` ni `verification`: la IA los llenaba con cualquier cosa («inferred»,
    # «Medellín, Colombia»). La procedencia la pone el código (semilla) o es «conversation».


class BrainEdge(BaseModel):
    model_config = ConfigDict(extra="ignore")
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_refs: list[str] | None = None
    provenance: str | None = None


@dataclass(frozen=True, slots=True)
class FieldSpec:
    name: str
    kind: FieldKind


@dataclass(frozen=True, slots=True)
class EntitySpec:
    name: str
    domain: str
    fields: tuple[FieldSpec, ...]
    maps_to: tuple[str, ...]
    label_es: str = ""
    deprecated: bool = False


@dataclass(frozen=True, slots=True)
class Ontology:
    entities: dict[str, EntitySpec]
    edges: dict[str, tuple[tuple[str, str], ...]]
    events: dict[str, tuple[frozenset[str], frozenset[str]]]
    entity_models: dict[str, type[BrainEntity]]
    edge_models: dict[str, type[BrainEdge]]
    schema: str = "saleads-brain-ontology/1"

    def permits_relation(self, source_type: str, relation: str, target_type: str) -> bool:
        """Validate typed edges against the same vocabulary as the graph schema."""
        if source_type not in self.entities or target_type not in self.entities:
            return False
        return any(
            source in ("Entity", source_type) and target in ("Entity", target_type)
            for source, target in self.edges.get(relation, ())
        )

    def field_kind(self, entity: str, field: str) -> FieldKind:
        for spec in self.entities[entity].fields:
            if spec.name == field:
                return spec.kind
        raise KeyError(f"{entity}.{field}")


def load_spec(text: str | None = None) -> dict[str, Any]:
    raw = text if text is not None else resources.files(__package__).joinpath("base.yaml").read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    if not isinstance(data, dict) or data.get("schema") not in SUPPORTED_SCHEMAS:
        raise ValueError("ontology_schema_invalid")
    return cast(dict[str, Any], data)


def build(spec: dict[str, Any]) -> Ontology:
    entities: dict[str, EntitySpec] = {}
    models: dict[str, type[BrainEntity]] = {}
    for name, body in spec["entities"].items():
        if not TYPE_NAME.fullmatch(name):
            raise ValueError(f"invalid_type_name:{name}")
        fields = []
        for field_name, opts in (body.get("fields") or {}).items():
            if not FIELD_NAME.fullmatch(field_name) or field_name in PROTECTED_FIELDS:
                raise ValueError(f"invalid_field:{name}.{field_name}")
            kind = (opts or {}).get("kind", "descriptive")
            if kind not in ("declared", "measured", "descriptive", "system"):
                raise ValueError(f"invalid_field_kind:{name}.{field_name}")
            fields.append(FieldSpec(field_name, cast(FieldKind, kind)))
        entities[name] = EntitySpec(
            name, body["domain"], tuple(fields), tuple(body.get("maps_to") or []),
            str(body.get("label_es") or name), bool(body.get("deprecated")),
        )
        # Los campos `system` quedan fuera del modelo que usa Graphiti: no los extrae ni los pisa.
        models[name] = _entity_model(name, BrainEntity, [f.name for f in fields if f.kind != "system"])
    edges: dict[str, tuple[tuple[str, str], ...]] = {}
    for name, pairs in spec["edges"].items():
        if not ASCII_NAME.fullmatch(name):
            raise ValueError(f"invalid_edge_name:{name}")
        checked = []
        for source, target in pairs:
            for endpoint in (source, target):
                if endpoint != "Entity" and endpoint not in entities:
                    raise ValueError(f"unknown_edge_endpoint:{name}:{endpoint}")
            checked.append((source, target))
        edges[name] = tuple(checked)
    edge_models = {name: create_model(name, __base__=BrainEdge) for name in edges}
    events: dict[str, tuple[frozenset[str], frozenset[str]]] = {}
    for kind, body in spec["events"].items():
        ents = frozenset(body["entities"])
        rels = frozenset(body["edges"])
        if not ents <= entities.keys() or not rels <= edges.keys():
            raise ValueError(f"event_references_unknown_type:{kind}")
        if ents & CORE_TYPES or any(entities[name].deprecated for name in ents):
            raise ValueError(f"event_uses_core_or_deprecated_type:{kind}")
        events[kind] = (ents, rels)
    return Ontology(entities, edges, events, models, edge_models, str(spec["schema"]))


@lru_cache(maxsize=1)
def base() -> Ontology:
    return build(load_spec())


def _entity_model(name: str, parent: type[BrainEntity], fields: list[str]) -> type[BrainEntity]:
    definitions: dict[str, Any] = {field: (str | None, None) for field in fields}
    return create_model(name, __base__=parent, **definitions)


def learned_types(
    path: str | Path | None, ontology: Ontology | None = None
) -> tuple[dict[str, type[BrainEntity]], dict[str, type[BrainEdge]]]:
    """Tipos aprendidos activos (exportados por el ledger).

    Cada tipo nuevo cuelga de un tipo base existente (`extends`); si el padre
    no existe, el tipo se ignora. Así un "paquete de novia" sigue siendo un
    ProductOrService para todo lo que ya entiende ese tipo.
    """
    if path is None:
        return {}, {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, {}
    onto = ontology or base()
    entities: dict[str, type[BrainEntity]] = {}
    edges: dict[str, type[BrainEdge]] = {}
    for item in data.get("proposals", []):
        name = str(item.get("name") or "")
        if not TYPE_NAME.fullmatch(name) or name in onto.entity_models:
            continue
        schema = item.get("schema") or {}
        if item.get("proposal_kind") == "entity_type":
            parent = onto.entity_models.get(str(schema.get("extends") or ""))
            if parent is None:
                continue
            fields = [
                str(field)
                for field in (schema.get("fields") or {})
                if FIELD_NAME.fullmatch(str(field)) and field not in PROTECTED_FIELDS
            ]
            entities[name] = _entity_model(name, parent, fields)
        elif item.get("proposal_kind") == "edge_type":
            edges[name] = create_model(name, __base__=BrainEdge)
    return entities, edges


def ontology_for_event(
    kind: str, learned_path: str | Path | None = None
) -> tuple[dict[str, type[BrainEntity]], dict[str, type[BrainEdge]]]:
    onto = base()
    ents, rels = onto.events.get(kind, (frozenset({"Evidence"}), frozenset({"EVIDENCED_BY"})))
    entity_models = {name: onto.entity_models[name] for name in ents}
    edge_models = {name: onto.edge_models[name] for name in rels}
    learned_entities, learned_edges = learned_types(learned_path, onto)
    entity_models.update(learned_entities)
    edge_models.update(learned_edges)
    return entity_models, edge_models
