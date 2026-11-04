"""Reglas de gobierno de la ontología aprendida (portadas de ORQA).

- Una propuesta necesita al menos dos fuentes distintas.
- La autoactivación es solo semántica (vocabulario aditivo, `operational: false`)
  y nunca ocurre si la propuesta toca vocabulario sensible: dinero, promesas,
  permisos o datos personales. Esas pasan por el dueño.
- El vocabulario se compara por palabra completa, en español y en inglés.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

PROPOSAL_KINDS = frozenset({"entity_type", "edge_type", "alias", "business_concept"})
TRANSITIONS: dict[str, frozenset[str]] = {
    "PROPOSED": frozenset({"REVIEWED", "DEPRECATED"}),
    "REVIEWED": frozenset({"ACTIVE", "DEPRECATED"}),
    "ACTIVE": frozenset({"DEPRECATED"}),
    "DEPRECATED": frozenset(),
}

# Operativo (de ORQA) + marketing (invariante 8 raíz y reglas de dinero).
_FORBIDDEN_EN = {
    "permission",
    "permissions",
    "publish",
    "contact",
    "contacts",
    "spend",
    "spending",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "auth",
    "identity",
    "privacy",
    "policy",
    "policies",
    "role",
    "roles",
    "instruction",
    "instructions",
    "tool",
    "tools",
    "capability",
    "capabilities",
    "grant",
    "revoke",
    "price",
    "prices",
    "pricing",
    "discount",
    "discounts",
    "budget",
    "budgets",
    "guarantee",
    "guarantees",
    "testimonial",
    "testimonials",
    "claim",
    "claims",
    "certification",
    "certifications",
    "medical",
    "email",
    "phone",
}
_FORBIDDEN_ES = {
    "permiso",
    "permisos",
    "publicar",
    "contacto",
    "contactos",
    "gasto",
    "gastos",
    "credencial",
    "credenciales",
    "secreto",
    "secretos",
    "identidad",
    "privacidad",
    "politica",
    "politicas",
    "rol",
    "roles",
    "instruccion",
    "instrucciones",
    "herramienta",
    "herramientas",
    "precio",
    "precios",
    "descuento",
    "descuentos",
    "presupuesto",
    "presupuestos",
    "garantia",
    "garantias",
    "testimonio",
    "testimonios",
    "certificacion",
    "certificaciones",
    "medico",
    "medica",
    "correo",
    "telefono",
}
FORBIDDEN_WORDS = frozenset(_FORBIDDEN_EN | _FORBIDDEN_ES)

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()


def words(text: str) -> set[str]:
    """Palabras completas, separando camelCase y snake_case, sin tildes."""
    return {_fold(token) for token in _WORD.findall(_CAMEL.sub(" ", text))}


def sensitive_words(*texts: str) -> set[str]:
    found: set[str] = set()
    for text in texts:
        found |= words(text) & FORBIDDEN_WORDS
    return found


def validate_proposal(*, proposal_kind: str, name: str, evidence_refs: list[str]) -> list[str]:
    """Devuelve las fuentes distintas o lanza ValueError."""
    if proposal_kind not in PROPOSAL_KINDS:
        raise ValueError("invalid_ontology_proposal_kind")
    if not name.strip():
        raise ValueError("ontology_proposal_requires_name")
    independent = sorted({ref.strip() for ref in evidence_refs if ref.strip()})
    if len(independent) < 2:
        raise ValueError("ontology_proposal_requires_two_independent_sources")
    return independent


def assert_safe_semantic(*, name: str, definition: str, schema: dict[str, Any], independent_sources: int) -> None:
    if schema.get("autonomy_class") != "semantic_only" or schema.get("operational") is not False:
        raise ValueError("semantic_auto_activation_contract_required")
    if independent_sources < 2:
        raise ValueError("semantic_auto_activation_requires_two_sources")
    hits = sensitive_words(name, definition, json.dumps(schema, ensure_ascii=False))
    if hits:
        raise ValueError("semantic_auto_activation_requires_owner_review")


def assert_transition(current: str, target: str) -> None:
    if target not in TRANSITIONS.get(current, frozenset()):
        raise ValueError(f"invalid_ontology_transition:{current}->{target}")
