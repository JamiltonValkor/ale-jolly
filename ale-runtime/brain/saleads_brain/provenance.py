"""Procedencia y precedencia de los hechos del cerebro.

La lista de procedencias es cerrada y única: la usan la ontología, la
extracción de lecciones (OSB-004) y el buzón del Cerebro SaleADS (OSB-015).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class Provenance(StrEnum):
    SALEADS_SEED = "saleads_seed"
    OWNER_SAID = "owner_said"
    OWNER_DECIDED = "owner_decided"
    PLATFORM = "platform"
    INFERRED = "inferred"
    INFERRED_FROM_PLATFORM = "inferred_from_platform"


# `system`: lo escriben solo las tools tipadas del loop (MLB-009); no lo ve la extracción de Graphiti.
FieldKind = Literal["declared", "measured", "descriptive", "system"]

OWNER = frozenset({Provenance.OWNER_SAID, Provenance.OWNER_DECIDED})
PLATFORM_DERIVED = frozenset({Provenance.PLATFORM, Provenance.INFERRED_FROM_PLATFORM})
INFERRED = frozenset({Provenance.INFERRED, Provenance.INFERRED_FROM_PLATFORM})
# Únicas procedencias que pueden convertirse en lección compartida (ADR0020).
SHAREABLE = OWNER

# Rango por tipo de campo: mayor = manda. Lo inferido siempre queda abajo.
_RANK: dict[FieldKind, dict[Provenance, int]] = {
    "declared": {
        Provenance.OWNER_DECIDED: 50,
        Provenance.OWNER_SAID: 50,
        Provenance.SALEADS_SEED: 40,
        Provenance.PLATFORM: 30,
        Provenance.INFERRED: 10,
        Provenance.INFERRED_FROM_PLATFORM: 10,
    },
    "measured": {
        Provenance.PLATFORM: 50,
        Provenance.SALEADS_SEED: 45,
        Provenance.OWNER_DECIDED: 30,
        Provenance.OWNER_SAID: 30,
        Provenance.INFERRED_FROM_PLATFORM: 10,
        Provenance.INFERRED: 10,
    },
    "descriptive": {
        Provenance.OWNER_DECIDED: 50,
        Provenance.OWNER_SAID: 50,
        Provenance.SALEADS_SEED: 40,
        Provenance.PLATFORM: 40,
        Provenance.INFERRED: 10,
        Provenance.INFERRED_FROM_PLATFORM: 10,
    },
    "system": {
        Provenance.OWNER_DECIDED: 50,
        Provenance.OWNER_SAID: 50,
        Provenance.SALEADS_SEED: 40,
        Provenance.PLATFORM: 40,
        Provenance.INFERRED: 10,
        Provenance.INFERRED_FROM_PLATFORM: 10,
    },
}


@dataclass(frozen=True, slots=True)
class Claim:
    """Un valor candidato para un campo, con su procedencia."""

    value: object
    provenance: Provenance
    validated: bool = False

    @property
    def is_inferred(self) -> bool:
        return self.provenance in INFERRED and not self.validated


@dataclass(frozen=True, slots=True)
class Resolution:
    winner: Claim
    discrepancy: Claim | None
    reason: str


def resolve(kind: FieldKind, current: Claim | None, incoming: Claim) -> Resolution:
    """Decide qué valor manda para un campo.

    - En lo declarado (precio, oferta) manda el dueño.
    - En lo medido (gasto, conversiones) manda la plataforma; si el dueño dice
      otra cosa, queda registrada la diferencia.
    - Lo inferido nunca reemplaza lo validado.
    """
    if current is None:
        return Resolution(incoming, None, "first_value")
    if current.value == incoming.value:
        keep = current if _rank(kind, current) >= _rank(kind, incoming) else incoming
        return Resolution(keep, None, "same_value")
    if incoming.is_inferred and not current.is_inferred:
        return Resolution(current, incoming, "inferred_never_replaces_validated")
    if _rank(kind, incoming) >= _rank(kind, current):
        return Resolution(incoming, current, f"{kind}_precedence")
    return Resolution(current, incoming, f"{kind}_precedence")


def _rank(kind: FieldKind, claim: Claim) -> int:
    base = _RANK[kind][claim.provenance]
    return base + (5 if claim.validated else 0)
