"""La cita del dueño (MCB-009, MCN-008): solo es decisión del dueño lo que el dueño dijo."""

import sqlite3
import time

from saleads_brain import quotes


def state_db(path, rows, sessions=(("s1", "telegram"),)):
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);"
        "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL);"
    )
    db.executemany("INSERT INTO sessions VALUES (?,?,0)", sessions)
    now = time.time()
    db.executemany(
        "INSERT INTO messages(session_id, role, content, timestamp) VALUES (?,?,?,?)",
        [(row[0], row[1], row[2], row[3] if len(row) > 3 else now) for row in rows],
    )
    db.commit()
    db.close()
    return path


def test_normalize_drops_accents_punctuation_and_case() -> None:
    assert quotes.normalize("  No activé NADA todavía, ¿listo?  ") == "no active nada todavia listo"


def test_quote_said_by_the_owner_is_ok(tmp_path) -> None:
    """Regla: una cita que está en el chat del dueño valida su decisión."""
    db = state_db(tmp_path / "state.db", [
        ("s1", "assistant", "¿Quiere que deje listas las campañas?"),
        ("s1", "user", "Hágale usted que sabe, pero no ponga anuncios todavía"),
    ])
    assert quotes.check(db, "no ponga anuncios TODAVIA") == quotes.OK


def test_echo_of_ale_is_detected_without_accents_and_by_containment(tmp_path) -> None:
    """Regla: si el dueño repite lo que Ale acaba de decir, no es su decisión (F3)."""
    db = state_db(tmp_path / "state.db", [
        ("s1", "assistant", "Listo. No activé nada. Te aviso cuando esté."),
        ("s1", "user", "No active nada todavía, ¿listo?"),
    ])
    assert quotes.check(db, "No active nada todavía, ¿listo?") == quotes.ECHO
    # También por solapamiento de palabras con contenido (≥ 80 %) en un mismo mensaje de Ale.
    assert quotes.is_echo("presupuesto mitades campañas", ["Reparto el presupuesto por mitades entre las dos campañas"])
    assert not quotes.is_echo("no ponga anuncios todavía", ["¿Quiere que deje listas las campañas en pausa?"])


def test_cron_tick_kanban_and_old_messages_never_count_as_quotes(tmp_path) -> None:
    """Regla: el mensaje del tick (sessions.source='cron', role='user') y las tarjetas no son el dueño."""
    old = time.time() - 15 * 86_400
    db = state_db(
        tmp_path / "state.db",
        [
            ("tick", "user", "Vuelta automática: no ponga anuncios todavía"),
            ("s1", "user", "[kanban] Task 12: no ponga anuncios todavía"),
            ("s1", "user", "no ponga anuncios todavía", old),
        ],
        sessions=(("s1", "telegram"), ("tick", "cron")),
    )
    assert quotes.check(db, "no ponga anuncios todavía") == quotes.NOT_FOUND


def test_missing_state_db_or_empty_quote_never_blocks(tmp_path) -> None:
    assert quotes.check(tmp_path / "nope.db", "hola dueño") == quotes.PENDING
    assert quotes.check(tmp_path / "nope.db", " ¿? ") == quotes.NO_QUOTE
