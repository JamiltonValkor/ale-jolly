from saleads_brain.ontology import base
from saleads_brain.provenance import SHAREABLE, Claim, Provenance, _rank, resolve


def kind(entity: str, field: str):
    return base().field_kind(entity, field)


def test_owner_price_beats_scraped_price() -> None:
    scraped = Claim(99, Provenance.INFERRED)
    owner = Claim(120, Provenance.OWNER_SAID)
    assert resolve(kind("Offer", "price"), scraped, owner).winner == owner
    # Y en el orden inverso, el scraping no desplaza al dueño.
    assert resolve(kind("Offer", "price"), owner, scraped).winner == owner


def test_platform_spend_beats_owner_and_keeps_discrepancy() -> None:
    owner = Claim(500, Provenance.OWNER_SAID)
    platform = Claim(430, Provenance.PLATFORM)
    result = resolve(kind("Campaign", "spend"), owner, platform)
    assert result.winner == platform
    assert result.discrepancy == owner
    again = resolve(kind("Campaign", "spend"), platform, owner)
    assert again.winner == platform and again.discrepancy == owner


def test_inferred_never_replaces_validated() -> None:
    validated = Claim("Mujeres 25-40", Provenance.SALEADS_SEED, validated=True)
    inferred = Claim("Hombres 18-24", Provenance.INFERRED)
    result = resolve(kind("Segment", "description"), validated, inferred)
    assert result.winner == validated
    assert result.reason == "inferred_never_replaces_validated"


def test_first_value_is_accepted() -> None:
    claim = Claim("beauty", Provenance.SALEADS_SEED)
    assert resolve("descriptive", None, claim).winner == claim


def test_feedback_without_owner_quote_never_outranks_what_was_inferred(tmp_path) -> None:
    """Regla (MCB-009, F3): sin la cita del dueño, lo que Ale registró como decisión pesa como inferido."""
    from saleads_brain.graph import InMemoryStore
    from saleads_brain.ledger import Ledger
    from saleads_brain.loop import LoopWriter

    writer = LoopWriter(InMemoryStore(), Ledger(tmp_path / "l.db"))
    out = writer.record_decision(business_id="00000000-0000-4000-8000-000000000002", text="No uses mujeres de 20",
                                 scope=["avatar:mamas"])
    assert out["verification"] == "INFERRED" and out["degradado"] == "sin_cita"
    degraded = Claim("sin mujeres de 20", Provenance(out["provenance"]))
    inferred = Claim("mujeres de 20", Provenance.INFERRED)
    validated = Claim("mujeres de 30", Provenance.OWNER_DECIDED)
    assert degraded.is_inferred
    assert resolve("system", validated, degraded).winner == validated
    assert resolve("system", degraded, validated).winner == validated
    # Mismo rango que lo inferido: no queda por encima, y no puede volverse lección compartida (ADR0020).
    assert _rank("system", degraded) == _rank("system", inferred) < _rank("system", validated)
    assert degraded.provenance not in SHAREABLE
