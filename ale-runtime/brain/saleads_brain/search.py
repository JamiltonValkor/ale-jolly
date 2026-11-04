"""Búsqueda por palabras del cerebro, sin modelo (MCB-009).

- `search_text`: nombre + resumen en minúsculas y sin tildes; se guarda en cada nodo y entra
  al índice de texto completo de `:Entity` (Ale escribe «aprobo» o «aprobó» según el modelo).
- `terms`: la consulta en minúsculas, sin tildes, con los separadores de FalkorDB y sin
  palabras vacías en español ni en inglés.
- `fulltext_query`: el texto exacto que recibe `db.idx.fulltext.queryNodes` (términos con ` | `,
  como `graphiti_core/driver/falkordb/fulltext.py:79`).
- `rank`: BM25 sobre los nodos; lo usan `InMemoryStore` y el respaldo de `FalkorStore`.
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Iterable
from typing import Protocol

# Separadores de FalkorDB (`graphiti_core/driver/falkordb/fulltext.py:11-51`, Graphiti 0.31.1) más `¿` y `¡`.
_SEPARATORS = ",.<>{}[]\"':;!@#$%^&*()-+=~?|/\\`¿¡"
_SEPARATOR_MAP = str.maketrans({char: " " for char in _SEPARATORS})

# Palabras vacías del índice de Graphiti (`graphiti_core/driver/falkordb/__init__.py`): la DDL del cerebro usa
# las mismas para que los grafos viejos (índice creado por Graphiti) y los nuevos se comporten igual.
GRAPHITI_STOPWORDS = (
    "a",
    "is",
    "the",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "if",
    "in",
    "into",
    "it",
    "no",
    "not",
    "of",
    "on",
    "or",
    "such",
    "that",
    "their",
    "then",
    "there",
    "these",
    "they",
    "this",
    "to",
    "was",
    "will",
    "with",
)

# Solo para la consulta (sin tildes, porque se comparan después de quitarlas).
SPANISH_STOPWORDS = frozenset(
    [
        "a",
        "al",
        "algo",
        "algun",
        "alguna",
        "algunas",
        "alguno",
        "algunos",
        "ante",
        "antes",
        "asi",
        "aun",
        "aunque",
        "cada",
        "como",
        "con",
        "contra",
        "cual",
        "cuales",
        "cuando",
        "cuanto",
        "de",
        "del",
        "desde",
        "donde",
        "dos",
        "e",
        "el",
        "ella",
        "ellas",
        "ello",
        "ellos",
        "en",
        "entre",
        "era",
        "eran",
        "eres",
        "es",
        "esa",
        "esas",
        "ese",
        "eso",
        "esos",
        "esta",
        "estaba",
        "estado",
        "estan",
        "estar",
        "estas",
        "este",
        "esto",
        "estos",
        "fue",
        "fueron",
        "ha",
        "habia",
        "han",
        "has",
        "hay",
        "he",
        "hasta",
        "la",
        "las",
        "le",
        "les",
        "lo",
        "los",
        "mas",
        "me",
        "mi",
        "mis",
        "mucho",
        "muchos",
        "muy",
        "nada",
        "ni",
        "no",
        "nos",
        "nosotros",
        "o",
        "otra",
        "otras",
        "otro",
        "otros",
        "para",
        "pero",
        "poco",
        "por",
        "porque",
        "que",
        "quien",
        "quienes",
        "se",
        "sea",
        "segun",
        "ser",
        "si",
        "sido",
        "sin",
        "sobre",
        "son",
        "su",
        "sus",
        "tal",
        "tambien",
        "te",
        "tiene",
        "tienen",
        "ti",
        "tu",
        "tus",
        "un",
        "una",
        "uno",
        "unos",
        "usted",
        "ustedes",
        "y",
        "ya",
        "yo",
    ]
)
STOPWORDS = SPANISH_STOPWORDS | frozenset(GRAPHITI_STOPWORDS)


def fold(text: str) -> str:
    """Minúsculas y sin marcas diacríticas (NFKD): «Aprobó» → «aprobo»."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def search_text(name: str, summary: str) -> str:
    """Lo que se indexa además de `name` y `summary`: los dos, plegados y con los separadores como espacio."""
    return " ".join(fold(f"{name} {summary}").translate(_SEPARATOR_MAP).split())


def tokens(text: str) -> list[str]:
    return fold(text).translate(_SEPARATOR_MAP).split()


def terms(query: str) -> list[str]:
    """Términos de la consulta, en orden y sin repetir. Si todo son palabras vacías, se usan tal cual."""
    words = tokens(query)
    useful = [w for w in words if w not in STOPWORDS] or words
    return list(dict.fromkeys(useful))


def fulltext_query(query_terms: Iterable[str]) -> str:
    """`(presupuesto | aprobo)`. Los términos ya vienen sin separadores, así que no hay nada que escapar."""
    joined = " | ".join(t for t in query_terms if t)
    return f"({joined})" if joined else ""


def _stem(word: str) -> str:
    """Plural simple, para parecerse al índice (que reduce «presupuestos» a «presupuesto»)."""
    if len(word) > 5 and word.endswith("es"):
        return word[:-2]
    if len(word) > 4 and word.endswith("s"):
        return word[:-1]
    return word


class Searchable(Protocol):
    @property
    def name(self) -> str: ...
    @property
    def summary(self) -> str: ...
    @property
    def created_at(self) -> str: ...


def rank[T: Searchable](nodes: Iterable[T], query_terms: list[str], limit: int) -> list[T]:
    """BM25 (k1=1,2, b=0,75) sobre nombre + resumen; empate: el más reciente primero. Sin coincidencias, nada."""
    wanted = [_stem(t) for t in query_terms]
    if not wanted:
        return []
    docs = [(node, [_stem(w) for w in search_text(node.name, node.summary).split()]) for node in nodes]
    if not docs:
        return []
    average = sum(len(words) for _, words in docs) / len(docs) or 1.0
    frequency = {t: sum(1 for _, words in docs if t in words) for t in set(wanted)}
    scored: list[tuple[float, str, T]] = []
    for node, words in docs:
        score = 0.0
        for term in wanted:
            tf = words.count(term)
            if not tf:
                continue
            idf = math.log(1 + (len(docs) - frequency[term] + 0.5) / (frequency[term] + 0.5))
            score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len(words) / average))
        if score > 0:
            scored.append((score, node.created_at or "", node))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [node for _, _, node in scored[:limit]]
