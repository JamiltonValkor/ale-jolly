import json
import sqlite3

import pytest
from fixtures_seed import BUSINESS, SEED

from saleads_brain.day import CHECKPOINT, Episode, businesses_from_seed, ingest_day, read_messages
from saleads_brain.ledger import Ledger
from saleads_brain.lessons import extract_lessons, leaks


def state_db(path, rows):
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);"
        "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL);"
    )
    db.execute("INSERT INTO sessions VALUES ('s1','api',1760600000), ('cron1','cron',1760600000)")
    db.executemany("INSERT INTO messages(session_id, role, content, timestamp) VALUES (?,?,?,?)", rows)
    db.commit()
    db.close()


ROWS = [
    ("s1", "user", "Para Example Beauty quiero vender más kits de novia", 1760600000),
    ("s1", "assistant", "Listo, preparo ideas", 1760600010),
    ("cron1", "assistant", "Resumen del día", 1760600020),
]


def setup(tmp_path):
    db = tmp_path / "state.db"
    state_db(db, ROWS)
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps(SEED))
    return db, seed, Ledger(tmp_path / "l.db")


def test_cron_sessions_are_not_conversations_but_count_as_noise(tmp_path) -> None:
    db, _, _ = setup(tmp_path)
    episodes, noise, _ = read_messages(db, 0)
    assert [e.session_id for e in episodes] == ["s1"]
    assert sum(a for a, _ in noise.values()) == 2 and sum(o for _, o in noise.values()) == 1


@pytest.mark.asyncio
async def test_ingest_day_batches_and_advances_checkpoint(tmp_path) -> None:
    db, seed, ledger = setup(tmp_path)
    calls = []

    async def add(business_id, episodes):
        calls.append((business_id, len(episodes)))

    result = await ingest_day(ledger=ledger, state_db=db, seed_path=seed, add_batch=add)
    assert result["episodes"] == 1 and calls == [(BUSINESS, 1)]
    # Avanza también sobre el mensaje de cron (id 3): no se relee ni se recuenta como ruido.
    assert ledger.checkpoint(CHECKPOINT) == "3"
    assert (await ingest_day(ledger=ledger, state_db=db, seed_path=seed, add_batch=add))["episodes"] == 0


@pytest.mark.asyncio
async def test_failed_batch_is_retried_and_never_lost(tmp_path) -> None:
    db, seed, ledger = setup(tmp_path)
    attempts = []

    async def failing(business_id, episodes):
        attempts.append(1)
        raise TimeoutError("provider timeout")

    async def no_sleep(_):
        return None

    result = await ingest_day(ledger=ledger, state_db=db, seed_path=seed, add_batch=failing, sleep=no_sleep)
    assert len(attempts) == 4 and result["pending"] == 1
    assert ledger.checkpoint(CHECKPOINT) is None


def test_leak_filter() -> None:
    assert leaks("Escribe a ana@x.com", [])
    assert leaks("Sube el precio a 120000", [])
    assert leaks("Example Beauty vende más con videos", ["Example Beauty"])
    assert not leaks("Mostrar el proceso completo genera más confianza que solo el resultado", ["Example Beauty"])


@pytest.mark.asyncio
async def test_extract_lessons_keeps_only_clean_owner_lessons(tmp_path) -> None:
    db, seed, ledger = setup(tmp_path)
    await ingest_day(ledger=ledger, state_db=db, seed_path=seed, add_batch=None)

    async def complete(_system, _user):
        return json.dumps(
            {
                "lessons": [
                    {
                        "text": "Mostrar el proceso completo genera más confianza que mostrar solo el resultado",
                        "provenance": "owner_decided",
                    },
                    {
                        "text": "Example Beauty debe subir el precio del kit a 200000",
                        "provenance": "owner_said",
                    },
                    {"text": "corto", "provenance": "owner_said"},
                ]
            }
        )

    result = await extract_lessons(ledger=ledger, complete=complete, banned_names={BUSINESS: ["Example Beauty"]})
    assert result == {"stored": 1, "discarded": 2}
    assert [lesson["provenance"] for lesson in ledger.lessons()] == ["owner_decided"]


def test_routing_knows_the_business_by_its_products(tmp_path) -> None:
    """Laboratorio L1-06: «el combo rayo es el que más sale» es de Burger Rayo, aunque no lo nombre."""
    from saleads_brain.day import Business, route

    salon = Business("salon", ["Glamour Novias", "Paquete de novia completo"])
    burger = Business("burger", ["Burger Rayo", "Combo Rayo"])
    episode = Episode("s", 1, 0.0, "Dueño: el combo rayo es el que más sale los viernes", ["x"])
    assert route(episode, [salon, burger]) == "burger"
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps({"schema": "saleads-seed/1", "businesses": [{
        "business_id": "b1",
        "context": {"facts": {"business": {"name": "Burger Rayo"}, "products": [{"name": "Combo Rayo"}, {"name": "Té"}],
                              "services": [{"name": "Domicilio gratis"}]}},
    }]}))
    assert businesses_from_seed(seed)[0].names == ["Burger Rayo", "Combo Rayo", "Domicilio gratis"]


def test_a_long_session_is_split_not_truncated(tmp_path) -> None:
    """Laboratorio H8: el chat del dueño es una sesión larga; un día largo no se corta a 8.000 caracteres."""
    db = tmp_path / "state.db"
    state_db(db, [("s1", role, ch * 3000, 1760600000 + i)
                  for i, (role, ch) in enumerate([("user", "a"), ("assistant", "b"), ("user", "c"), ("assistant", "d")])])
    episodes, _, _ = read_messages(db, 0)
    assert len(episodes) == 2
    assert sum(len(e.text) for e in episodes) > 12000
    assert len({e.last_message_id for e in episodes}) == 2


@pytest.mark.asyncio
async def test_noise_accumulates_and_the_checkpoint_passes_cron_rows(tmp_path) -> None:
    """Laboratorio: la razón de ruido se sobrescribía con solo el mensaje de cron de la corrida siguiente."""
    db, seed, ledger = setup(tmp_path)

    async def ok(_business: str, _batch: list) -> None:
        return None

    await ingest_day(ledger=ledger, state_db=db, seed_path=seed, add_batch=ok)
    await ingest_day(ledger=ledger, state_db=db, seed_path=seed, add_batch=ok)
    report = ledger.value_report(BUSINESS, "2026-10-30")
    assert report["assistant_messages"] == 2 and report["owner_messages"] == 1
    assert ledger.checkpoint(CHECKPOINT) == "3"
