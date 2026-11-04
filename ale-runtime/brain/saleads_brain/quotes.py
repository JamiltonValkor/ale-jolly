"""La cita del dueño (regla anti-ruido de MCN-008, MCB-009).

Una decisión del dueño solo queda validada si su cita literal aparece en un mensaje del dueño en
`state.db` de Hermes y no es un eco de lo que Ale acababa de decir. Nunca bloquea: devuelve un
estado y quien escribe degrada la procedencia.

- `ok`: la cita está en un mensaje del dueño (últimos 14 días, sin cron ni `[kanban]`) y no es eco.
- `cita_no_encontrada`: no está en ningún mensaje del dueño.
- `eco_de_ale`: está, pero repite una frase de Ale de los 6 mensajes anteriores de esa sesión.
- `pendiente_de_verificar`: `state.db` no se puede leer ahora.

`state.db` se escribe antes de la primera llamada al modelo del turno (compuerta MCB-000 paso 37),
así que la cita se puede verificar en el momento en que corre la tool.
"""

from __future__ import annotations

import re
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from pathlib import Path

from saleads_brain.search import STOPWORDS, fold

OK = "ok"
NOT_FOUND = "cita_no_encontrada"
ECHO = "eco_de_ale"
PENDING = "pendiente_de_verificar"
NO_QUOTE = "sin_cita"

MAX_QUOTE = 500
WINDOW_DAYS = 14
ALE_MESSAGES = 6
MIN_PHRASE_WORDS = 3
CONTENT_OVERLAP = 0.8
MAX_OWNER_MESSAGES = 2000

QuoteChecker = Callable[[str], str]

_PHRASES = re.compile(r"[.!?¿¡;:\n]+")


def normalize(text: str) -> str:
    """NFKD sin marcas diacríticas, minúsculas, sin puntuación y con espacios simples."""
    return " ".join(re.sub(r"[^\w\s]|_", " ", fold(text)).split())


def _contains(haystack: str, needle: str) -> bool:
    return bool(needle) and f" {needle} " in f" {haystack} "


def _content_words(text: str) -> set[str]:
    return {w for w in text.split() if w not in STOPWORDS}


def is_echo(quote: str, ale_messages: list[str]) -> bool:
    """Eco: una frase de Ale de 3 o más palabras está en la cita, o el 80 % de las palabras con contenido de la
    cita está en un mismo mensaje de Ale. Ale «No activé nada» → cita «No active nada todavía, ¿listo?»."""
    norm = normalize(quote)
    content = _content_words(norm)
    for message in ale_messages:
        for phrase in _PHRASES.split(message):
            words = normalize(phrase)
            if len(words.split()) >= MIN_PHRASE_WORDS and _contains(norm, words):
                return True
        if content and len(content & set(normalize(message).split())) >= CONTENT_OVERLAP * len(content):
            return True
    return False


def check(state_db: Path, quote: str, now: float | None = None) -> str:
    """Busca la cita en los mensajes del dueño de `state.db` (solo lectura) y detecta el eco."""
    norm = normalize(quote[:MAX_QUOTE])
    if not norm:
        return NO_QUOTE
    if not state_db.exists():
        return PENDING
    since = (time.time() if now is None else now) - WINDOW_DAYS * 86_400
    try:
        with closing(sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            owner = db.execute(
                "SELECT m.id, m.session_id, m.content FROM messages m LEFT JOIN sessions s ON s.id = m.session_id "
                "WHERE m.role = 'user' AND COALESCE(s.source, '') <> 'cron' AND m.content IS NOT NULL "
                "AND m.content NOT LIKE '[kanban]%' AND m.timestamp >= ? ORDER BY m.id DESC LIMIT ?",
                (since, MAX_OWNER_MESSAGES),
            ).fetchall()
            found = next((row for row in owner if _contains(normalize(str(row["content"])), norm)), None)
            if found is None:
                return NOT_FOUND
            ale = db.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND id < ? "
                "AND content IS NOT NULL AND content <> '' ORDER BY id DESC LIMIT ?",
                (found["session_id"], found["id"], ALE_MESSAGES),
            ).fetchall()
    except sqlite3.Error:
        return PENDING
    return ECHO if is_echo(quote, [str(row["content"]) for row in ale]) else OK


def checker_for(state_db: Path) -> QuoteChecker:
    return lambda quote: check(state_db, quote)
