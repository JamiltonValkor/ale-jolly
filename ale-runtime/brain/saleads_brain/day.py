"""ingest-day: lo que pasó en las conversaciones con el dueño entra al grafo, en lote y en silencio.

Lee `state.db` de Hermes en solo lectura desde el último punto de control:
una conversación = un episodio (no un mensaje). Los jobs de cron no cuentan
como conversación con el dueño. Un lote que falla (timeout del proveedor) se
reintenta con espera; si sigue fallando, el punto de control no avanza y se
reintenta en la próxima corrida: ningún episodio se pierde.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from saleads_brain.ledger import Ledger
from saleads_brain.provenance import Provenance

CHECKPOINT = "state.db:messages"
MAX_MESSAGES = 2000
MAX_EPISODE_CHARS = 8000
BATCH = 10
RETRIES = (5.0, 15.0, 45.0)


@dataclass(slots=True)
class Episode:
    session_id: str
    last_message_id: int
    started_at: float
    text: str
    owner_lines: list[str]


@dataclass(slots=True)
class Business:
    business_id: str
    names: list[str]


def read_messages(state_db: Path, after_id: int) -> tuple[list[Episode], dict[str, tuple[int, int]], int]:
    """Episodios de conversación, conteo diario (asistente, dueño) para la métrica de ruido y el
    último id leído (el checkpoint avanza hasta ahí, también sobre mensajes de cron)."""
    if not state_db.exists():
        return [], {}, after_id
    db = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            "SELECT m.id, m.session_id, m.role, m.content, m.timestamp, COALESCE(s.source, '') AS source "
            "FROM messages m LEFT JOIN sessions s ON s.id = m.session_id "
            "WHERE m.id > ? AND m.role IN ('user', 'assistant') AND m.content IS NOT NULL AND m.content <> '' "
            "ORDER BY m.id LIMIT ?",
            (after_id, MAX_MESSAGES),
        ).fetchall()
    finally:
        db.close()
    sessions: dict[str, list[sqlite3.Row]] = defaultdict(list)
    noise: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for row in rows:
        day = datetime.fromtimestamp(float(row["timestamp"]), UTC).date().isoformat()
        noise[day][0 if row["role"] == "assistant" else 1] += 1
        if row["source"] != "cron":
            sessions[row["session_id"]].append(row)
    episodes = [episode for items in sessions.values() for episode in _windows(items)]
    episodes.sort(key=lambda e: e.last_message_id)
    last_id = max((int(row["id"]) for row in rows), default=after_id)
    return episodes, {day: (counts[0], counts[1]) for day, counts in noise.items()}, last_id


def _line(row: sqlite3.Row) -> str:
    return ("Dueño: " if row["role"] == "user" else "Asistente: ") + str(row["content"])


def _windows(items: list[sqlite3.Row]) -> list[Episode]:
    """Una sesión se parte en tramos de hasta MAX_EPISODE_CHARS, sin cortar mensajes: el chat
    del dueño es una sola sesión larga y un día largo no puede perderse (laboratorio H8)."""
    chunks: list[list[sqlite3.Row]] = [[]]
    size = 0
    for row in items:
        line = len(_line(row)) + 1
        if chunks[-1] and size + line > MAX_EPISODE_CHARS:
            chunks.append([])
            size = 0
        chunks[-1].append(row)
        size += line
    out = []
    for chunk in chunks:
        owner = [str(r["content"]) for r in chunk if r["role"] == "user"]
        if not owner:
            continue
        out.append(
            Episode(
                session_id=str(chunk[0]["session_id"]),
                last_message_id=max(int(r["id"]) for r in chunk),
                started_at=float(chunk[0]["timestamp"]),
                text="\n".join(_line(r) for r in chunk)[:MAX_EPISODE_CHARS],
                owner_lines=owner,
            )
        )
    return out


def businesses_from_seed(seed_path: Path) -> list[Business]:
    if not seed_path.exists():
        return []
    data = json.loads(seed_path.read_text(encoding="utf-8"))
    out = []
    for item in data.get("businesses", []) if isinstance(data, dict) else []:
        business_id = str(item.get("business_id") or "")
        facts = ((item.get("context") or {}).get("facts") or {}) if isinstance(item, dict) else {}
        name = str((facts.get("business") or {}).get("name") or "")
        # El negocio también se reconoce por sus productos y servicios (laboratorio L1-06).
        offers = [
            str((row or {}).get("name") or "")
            for kind in ("products", "services")
            for row in (facts.get(kind) or [])
            if isinstance(row, dict)
        ]
        if business_id:
            out.append(Business(business_id, [n for n in (name, *offers) if len(n) >= 4]))
    return out


def route(episode: Episode, businesses: Sequence[Business]) -> str | None:
    """Negocio del episodio: el más nombrado (por su nombre, productos o servicios); si no se
    nombra ninguno, el primero (principal)."""
    lowered = episode.text.casefold()
    scores = [(sum(lowered.count(n.casefold()) for n in b.names), -i) for i, b in enumerate(businesses)]
    best = max(scores, default=(0, 0))  # empate: gana el principal (índice menor)
    if best[0] > 0:
        return businesses[-best[1]].business_id
    return businesses[0].business_id if businesses else None


AddBatch = Callable[[str, list[Episode]], Awaitable[None]]


async def ingest_day(
    *,
    ledger: Ledger,
    state_db: Path,
    seed_path: Path,
    add_batch: AddBatch | None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any]:
    after = int(ledger.checkpoint(CHECKPOINT) or 0)
    episodes, noise, last_id = read_messages(state_db, after)
    businesses = businesses_from_seed(seed_path)
    if not businesses:
        return {"episodes": 0, "pending": len(episodes)}

    def commit() -> None:
        # Ruido y checkpoint juntos y una sola vez: así un mensaje nunca se cuenta dos veces.
        for day, (assistant, owner) in noise.items():
            ledger.add_noise(day, assistant, owner)
        if last_id > after:
            ledger.set_checkpoint(CHECKPOINT, str(last_id))

    if not episodes:
        commit()
        return {"episodes": 0, "pending": 0}
    by_business: dict[str, list[Episode]] = defaultdict(list)
    for episode in episodes:
        business_id = route(episode, businesses)
        if business_id:
            by_business[business_id].append(episode)
            for line in episode.owner_lines:
                ledger.record_event(
                    business_id=business_id,
                    kind="owner_message",
                    provenance=Provenance.OWNER_SAID,
                    source_uri=f"hermes://session/{episode.session_id}",
                    occurred_at=datetime.fromtimestamp(episode.started_at, UTC).isoformat(),
                    payload={"text": line[:2000]},
                )
    processed = 0
    failed = False
    for business_id, items in by_business.items():
        for start in range(0, len(items), BATCH):
            batch = items[start : start + BATCH]
            if add_batch is not None and not await _with_retries(_bind(add_batch, business_id, batch), sleep):
                failed = True
                break
            processed += len(batch)
        if failed:
            break
    if not failed:
        commit()
    return {"episodes": processed, "pending": 0 if not failed else len(episodes) - processed}


def _bind(add_batch: AddBatch, business_id: str, batch: list[Episode]) -> Callable[[], Awaitable[None]]:
    return lambda: add_batch(business_id, batch)


async def _with_retries(work: Callable[[], Awaitable[None]], sleep: Callable[[float], Awaitable[None]]) -> bool:
    for attempt, delay in enumerate((0.0, *RETRIES)):
        if attempt:
            await sleep(delay)
        try:
            await work()
            return True
        except Exception as error:  # noqa: BLE001 - el proveedor puede fallar de muchas formas; se reintenta
            # Solo la clase y la primera línea: nunca el texto de la conversación ni la key.
            first = str(error).splitlines()[0][:200] if str(error) else ""
            sys.stderr.write(f"ingest-day batch failed attempt={attempt + 1} error={type(error).__name__} {first}\n")
            continue
    return False
