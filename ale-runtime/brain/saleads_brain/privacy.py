"""Datos personales escritos en texto libre (laboratorio capa 1, L1-01 y L1-07).

Mismo criterio que el bootstrap del MCP (`redactFreeText`): emails, teléfonos y
direcciones se reemplazan antes de entrar al grafo. Precios, porcentajes y
números cortos se conservan.
"""

from __future__ import annotations

import re

REDACTED = "[dato personal]"
PATTERNS = (
    re.compile(r"[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}"),
    # Nunca pegado a letras, dígitos o guiones: así no corta un UUID ni un id.
    re.compile(r"(?<![\w-])(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{2,4}(?![\w-])"),
    re.compile(
        r"\b(?:calle|cl|carrera|cra|kr|avenida|av|diagonal|dg|transversal|tv)\.?\s*\d+[a-z]?\s*"
        r"(?:#|no\.?|n°)\s*\d+[a-z]?\s*-\s*\d+\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b\.?"),
)


def redact(text: str) -> str:
    for pattern in PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


# Dos palabras con mayúscula inicial seguidas («Laura Gómez»): nombre de persona probable.
PERSON = re.compile(r"\b([A-ZÁÉÍÓÚÑ][a-záéíóúñü]+)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñü]+)\b")
# Pares con mayúscula que no son personas (marcas y fechas comerciales frecuentes).
NOT_PEOPLE = {"meta ads", "google ads", "tiktok ads", "black friday", "cyber monday", "día madre", "san valentín"}
PERSON_MASK = "[persona]"


def redact_people(text: str, keep: list[str]) -> str:
    """Enmascara nombres propios de personas antes de que el texto llegue a la IA (L1-07).

    `keep`: nombres del negocio, sus productos y servicios, que nunca se tocan.
    """
    kept = [name.casefold() for name in keep]

    def mask(match: re.Match[str]) -> str:
        pair = match.group(0).casefold()
        if pair in NOT_PEOPLE or any(pair in name or name in pair for name in kept):
            return match.group(0)
        return PERSON_MASK

    return PERSON.sub(mask, text)
