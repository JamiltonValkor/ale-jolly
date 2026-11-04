import json

import yaml

from saleads_brain.ontology import (
    PROTECTED_FIELDS,
    base,
    learned_types,
    load_spec,
    ontology_for_event,
)

PII_FIELDS = {
    "email",
    "phone",
    "phone_number",
    "full_name",
    "first_name",
    "last_name",
    "birth_date",
    "birthday",
    "ssn",
    "document_id",
    "national_id",
    "ip_address",
    "home_address",
    "personal_address",
    "contact_channel",
    "whatsapp",
    "instagram_handle",
}
# Tipos que describen a terceros: no pueden tener nombre propio.
NO_NAME_TYPES = {"Customer", "Lead", "Feedback", "Deal"}


def test_yaml_and_generated_models_do_not_drift() -> None:
    spec = load_spec()
    onto = base()
    assert set(spec["entities"]) == set(onto.entity_models)
    for name, body in spec["entities"].items():
        generated = set(onto.entity_models[name].model_fields) - {
            "canonical_id",
            "source_refs",
            "provenance",
            "verification",
        }
        declared = {k for k, v in (body.get("fields") or {}).items() if (v or {}).get("kind") != "system"}
        assert generated == declared, name
    assert set(spec["edges"]) == set(onto.edge_models)


def test_no_type_models_personal_data() -> None:
    onto = base()
    for name, model in onto.entity_models.items():
        fields = set(model.model_fields)
        assert not fields & PII_FIELDS, name
        assert not fields & PROTECTED_FIELDS, name
        if name in NO_NAME_TYPES:
            assert "display_name" not in fields, name


def test_business_plan_coverage() -> None:
    domains = {spec.domain for spec in base().entities.values()}
    assert domains == {
        "identity",
        "offer",
        "market",
        "competition",
        "channels",
        "strategy",
        "operations",
        "learning",
        "meta",
        "bet",
        "verdict",
    }
    assert len(base().entities) == 38  # Existing37 + source-validated SpecialistExperience (MCL-006).


def test_learned_type_hangs_from_parent(tmp_path) -> None:
    path = tmp_path / "learned.json"
    path.write_text(
        json.dumps(
            {
                "proposals": [
                    {
                        "name": "BridalPackage",
                        "proposal_kind": "entity_type",
                        "schema": {"extends": "ProductOrService", "fields": {"includes": {}}},
                    },
                    {
                        "name": "Orphan",
                        "proposal_kind": "entity_type",
                        "schema": {"extends": "Nope"},
                    },
                ]
            }
        )
    )
    entities, _ = learned_types(path)
    assert set(entities) == {"BridalPackage"}
    assert issubclass(entities["BridalPackage"], base().entity_models["ProductOrService"])
    assert "category" in entities["BridalPackage"].model_fields


def test_event_kinds_reference_known_types() -> None:
    entities, edges = ontology_for_event("campaign")
    assert "Campaign" in entities and "PROMOTES" in edges and "MEASURED_BY" not in edges
    fallback, _ = ontology_for_event("unknown-kind")
    assert set(fallback) == {"Evidence"}


def test_yaml_is_the_only_source() -> None:
    raw = yaml.safe_load(
        load_spec.__globals__["resources"].files("saleads_brain.ontology").joinpath("base.yaml").read_text()
    )
    assert raw["schema"] == "saleads-brain-ontology/2"


def test_previous_ontology_schema_and_types_remain_readable() -> None:
    from saleads_brain.ontology import build

    spec = load_spec()
    spec["schema"] = "saleads-brain-ontology/1"
    assert build(load_spec(yaml.safe_dump(spec))).schema == "saleads-brain-ontology/1"
    assert {"Business", "Research", "Evidence", "Decision", "Learning"} <= base().entities.keys()


def test_experience_is_typed_only_and_uses_the_common_business_ontology() -> None:
    onto = base()
    fields = {item.name for item in onto.entities["SpecialistExperience"].fields}
    assert {"business_id", "role", "task_ref", "method", "observed_result", "correction", "applicability"} <= fields
    assert not {"spend", "cpa", "purchases"} & fields
    assert onto.permits_relation("SpecialistExperience", "ABOUT", "Business")
    assert onto.permits_relation("SpecialistExperience", "EVIDENCED_BY", "Evidence")
    assert onto.permits_relation("Research", "DERIVED_FROM", "SpecialistExperience")
    assert not onto.permits_relation("SpecialistExperience", "GIVES", "Result")
    assert not onto.permits_relation("NotAType", "EVIDENCED_BY", "Evidence")
    for kind in onto.events:
        assert "SpecialistExperience" not in ontology_for_event(kind)[0]


def test_entities_tolerate_stored_node_properties() -> None:
    """Laboratorio capa 1 (2026-10-30): Graphiti hidrata un nodo sembrado con todas sus
    propiedades guardadas (p. ej. `attributes_json`); el modelo no puede rechazarlas o
    todo el lote de conversaciones falla."""
    entities, edges = ontology_for_event("business_profile", None)
    model = next(iter(entities.values()))
    model(attributes_json='{"offering_kind": "service"}', provenance="saleads_seed")
    edge = next(iter(edges.values()))
    edge(attributes_json="{}", fact="x")


def test_names_are_ascii_and_relations_survive_the_snapshot() -> None:
    from saleads_brain.ontology import ASCII_NAME
    from saleads_brain.snapshot import _relation

    spec = load_spec()
    for name in [*spec["entities"], *spec["edges"]]:
        assert ASCII_NAME.fullmatch(name), name
    for name in spec["edges"]:
        assert _relation(name) == name


def test_core_types_never_reach_free_extraction() -> None:
    from saleads_brain.app import EXTRACTION_EVENTS
    from saleads_brain.ontology import CORE_TYPES

    for kind in EXTRACTION_EVENTS:
        entities, _ = ontology_for_event(kind)
        assert not set(entities) & CORE_TYPES, kind
        assert not set(entities) & {"Hypothesis", "Creative", "MetricObservation"}, kind


def test_loop_event_has_only_its_subset() -> None:
    entities, edges = ontology_for_event("loop")
    assert set(entities) == {"Avatar", "Angle", "Format", "Reference", "Competitor", "Landing", "Research", "Evidence"}
    assert set(edges) == {"SPEAKS_WITH", "INSPIRES", "COHERENT_WITH", "SUGGESTS", "EVIDENCED_BY"}


def test_loop_types_carry_spanish_labels_and_loop_attributes() -> None:
    onto = base()
    assert onto.entities["AdSet"].label_es == "Caja" and onto.entities["Bet"].label_es == "Apuesta"
    for name in ("Avatar", "Angle", "Format", "Bet", "AdSet", "Ad", "Result", "Verdict", "Learning"):
        fields = {f.name for f in onto.entities[name].fields}
        assert {"confidence", "evidence_count", "valid_from", "learned_at", "stage"} <= fields, name


def test_curator_tool_lists_exactly_the_writable_ontology_types():
    """The curator's commit tool enumerates entity_type; it must match what knowledge.candidate() admits."""
    import ast
    from pathlib import Path

    schemas = Path(__file__).resolve().parents[2] / "vm/extensions/saleads-memory/schemas.py"
    tree = ast.parse(schemas.read_text())
    listed = next(
        ast.literal_eval(node.value) for node in tree.body
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "CURATED_ENTITY_TYPES"
    )
    dedicated = {"Bet", "AdSet", "Ad", "Result", "Verdict", "SpecialistExperience"}
    writable = [name for name, spec in base().entities.items() if not spec.deprecated and name not in dedicated]
    assert list(listed) == writable
