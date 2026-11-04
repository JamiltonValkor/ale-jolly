"""Hechos tipados del dueño (AAB-019): vocabulario cerrado, procedencia y foto v3."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import jsonschema
import pytest

from saleads_brain import snapshot
from saleads_brain.facts import FactError, record_fact, snapshot_facts, vocabulary
from saleads_brain.ledger import Ledger

BIZ = "4a86123b-b734-4a25-8f37-08da32941f66"
OFFER = "0a720bbb-c1f4-4420-b340-a5670884bf07"
CONTRACTS = Path(__file__).parent.parent / "contracts"


def fact(ledger: Ledger, path: str, value: object, provenance: str = "owner_said", **extra: object) -> dict:
    return record_fact(ledger, business_id=BIZ, path=path, value=value, provenance=provenance, evidence="Lo dijo en el chat",
                       observed_at="2026-10-28T14:57:51+00:00", **extra)  # type: ignore[arg-type]


def test_vocabulary_package_copy_is_byte_identical_to_the_contract() -> None:
    source = (CONTRACTS / "saleads-brain-fact-paths-1.json").read_bytes()
    packaged = (Path(__file__).parent.parent / "saleads_brain" / "contracts" / "saleads-brain-fact-paths-1.json").read_bytes()
    assert hashlib.sha256(source).hexdigest() == hashlib.sha256(packaged).hexdigest()
    assert {"audiencia.ideal_client", "voz.voice_tones", "taxonomy.micro_niche", "offering.taxonomy.product_type"} <= set(vocabulary())
    assert all(spec.allowed_provenance == ("owner_said", "owner_decided", "agent_inferred") for spec in vocabulary().values())


def test_owner_fact_applies_and_inferred_never_replaces_it(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "l.db")
    first = fact(ledger, "audiencia.ideal_client", "Mamás de 30 a 45 años que cuidan su pelo")
    assert first == {"accepted": True, "applied": True, "fact_revision_id": first["fact_revision_id"], "path": "audiencia.ideal_client",
                     "provenance": "owner_said"}
    inferred = fact(ledger, "audiencia.ideal_client", "Jóvenes universitarias", "agent_inferred")
    assert inferred["applied"] is False and inferred["reason"] == "inferred_never_replaces_validated"
    assert ledger.current_fact(BIZ, "audiencia.ideal_client", None)["value"] == "Mamás de 30 a 45 años que cuidan su pelo"
    again = fact(ledger, "audiencia.ideal_client", "Mamás de 30 a 45 años que cuidan su pelo")
    assert again["noop"] is True
    corrected = fact(ledger, "audiencia.ideal_client", "Mamás de 25 a 45 años", "owner_decided")
    assert corrected["applied"] is True
    assert [f["value"] for f in snapshot_facts(ledger, BIZ)] == ["Mamás de 25 a 45 años"]


def test_enums_limits_privacy_and_offering_paths(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "l.db")
    with pytest.raises(FactError, match="value_not_in_enum"):
        fact(ledger, "voz.voice_tones", ["cercano y divertido"])
    with pytest.raises(FactError, match="value_too_long"):
        fact(ledger, "voz.voice_tones", ["close", "fun", "bold", "direct"])
    assert fact(ledger, "voz.voice_tones", ["Close", "fun", "close"])["applied"] is True
    assert ledger.current_fact(BIZ, "voz.voice_tones", None)["value"] == ["close", "fun"]
    with pytest.raises(FactError, match="path_not_in_vocabulary"):
        fact(ledger, "precio.base", "100000")
    with pytest.raises(FactError, match="provenance_not_allowed_for_path"):
        fact(ledger, "audiencia.interests", ["belleza"], "platform")
    with pytest.raises(FactError, match="offering_ref_required"):
        fact(ledger, "offering.taxonomy.product_type", "kit capilar")
    assert fact(ledger, "offering.taxonomy.product_type", "kit capilar", offering_ref=OFFER)["applied"] is True
    fact(ledger, "audiencia.pain_points", ["Escribe a laura@correo.com o al 300 123 4567"])
    assert "[dato personal]" in ledger.current_fact(BIZ, "audiencia.pain_points", None)["value"][0]
    with pytest.raises(FactError, match="falta:evidence"):
        record_fact(ledger, business_id=BIZ, path="marketing.primary_cta", value="Escríbenos", provenance="owner_said", evidence=" ",
                    observed_at="2026-11-01T14:33:41+00:00")


def test_snapshot_v3_carries_current_facts_and_validates(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "l.db")
    fact(ledger, "marketing.value_proposition", "Belleza que se nota sin gastar de más")
    fact(ledger, "audiencia.ideal_client", "Jóvenes", "agent_inferred")
    facts = snapshot_facts(ledger, BIZ)
    assert [(f["path"], f["provenance"]) for f in facts] == [("audiencia.ideal_client", "agent_inferred"),
                                                             ("marketing.value_proposition", "owner_said")]
    schema = json.loads((CONTRACTS / "saleads-explorer-snapshot-3.schema.json").read_text())
    business = {"business_id": BIZ, "nodes": [], "edges": [], "stats": {"nodes": 0, "edges": 0},
                "sections": {key: [] for key in ("my_business", "active_bets", "learned", "did_not_work", "your_corrections",
                                                 "to_confirm", "history")}, "facts": facts}
    data = {"schema": snapshot.SCHEMA, "generated_at": "", "businesses": [business]}
    jsonschema.validate(data, schema)
