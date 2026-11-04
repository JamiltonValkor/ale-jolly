import pytest

from saleads_brain.governance import sensitive_words
from saleads_brain.ledger import Ledger


@pytest.fixture()
def ledger(tmp_path) -> Ledger:
    return Ledger(tmp_path / "ledger.db")


SAFE = {"autonomy_class": "semantic_only", "operational": False, "extends": "ProductOrService"}


def test_single_source_proposal_is_rejected(ledger: Ledger) -> None:
    with pytest.raises(ValueError, match="two_independent_sources"):
        ledger.propose_ontology_change(
            business_id="b1",
            proposal_kind="entity_type",
            name="BridalPackage",
            definition="Paquete de novia",
            schema=SAFE,
            evidence_refs=["ep1", "ep1"],
            proposer_id="agent",
        )


def test_two_sources_safe_vocabulary_auto_activates(ledger: Ledger) -> None:
    pid = ledger.propose_ontology_change(
        business_id="b1",
        proposal_kind="entity_type",
        name="BridalPackage",
        definition="Paquete de novia con maquillaje y peinado",
        schema=SAFE,
        evidence_refs=["ep1", "ep2"],
        proposer_id="agent",
    )
    ledger.activate_safe_semantic(proposal_id=pid, note="auto")
    active = ledger.active_ontology("b1")["proposals"]
    assert [p["name"] for p in active] == ["BridalPackage"]


@pytest.mark.parametrize(
    "definition",
    ["Paquete con descuento de temporada", "Bundle with a seasonal discount", "Precio especial"],
)
def test_sensitive_vocabulary_requires_owner(ledger: Ledger, definition: str) -> None:
    pid = ledger.propose_ontology_change(
        business_id="b1",
        proposal_kind="entity_type",
        name="SeasonPack",
        definition=definition,
        schema=SAFE,
        evidence_refs=["ep1", "ep2"],
        proposer_id="agent",
    )
    with pytest.raises(ValueError, match="owner_review"):
        ledger.activate_safe_semantic(proposal_id=pid, note="auto")


def test_camel_case_name_is_split() -> None:
    assert sensitive_words("PriceBand") == {"price"}


def test_substring_does_not_block() -> None:
    # «precioso» contiene «precio», «spendthrift» contiene «spend»: no son esas palabras.
    assert sensitive_words("Un look precioso", "spendthrift crowd") == set()


def test_accents_are_folded() -> None:
    assert sensitive_words("Garantía total") == {"garantia"}


def test_review_lifecycle(ledger: Ledger) -> None:
    pid = ledger.propose_ontology_change(
        business_id="b1",
        proposal_kind="business_concept",
        name="Promo",
        definition="Promoción con descuento",
        schema={},
        evidence_refs=["a", "b"],
        proposer_id="agent",
    )
    with pytest.raises(ValueError, match="invalid_ontology_transition"):
        ledger.review_ontology_proposal(proposal_id=pid, target_status="ACTIVE", reviewer_id="owner", note="")
    ledger.review_ontology_proposal(proposal_id=pid, target_status="REVIEWED", reviewer_id="owner", note="ok")
    ledger.review_ontology_proposal(proposal_id=pid, target_status="ACTIVE", reviewer_id="owner", note="ok")
    assert ledger.active_ontology("b1")["proposals"][0]["name"] == "Promo"
