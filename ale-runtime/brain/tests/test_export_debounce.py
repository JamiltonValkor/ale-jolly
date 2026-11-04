"""AAB-013 (D27): exportación de la foto por evento, con debounce y flush de Ale."""

import asyncio
import json

from fixtures_seed import BUSINESS, SEED
from starlette.testclient import TestClient
from test_loop import call

from saleads_brain.app import Brain
from saleads_brain.export_debounce import SnapshotDebouncer
from saleads_brain.graph import InMemoryStore
from saleads_brain.ledger import Ledger
from saleads_brain.server import create_server
from saleads_brain.settings import load


class FakeClock:
    def __init__(self) -> None:
        self.sleeping: list[asyncio.Future[None]] = []

    async def sleep(self, _seconds: float) -> None:
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.sleeping.append(future)
        await future

    async def advance(self) -> None:
        for future in self.sleeping:
            if not future.done():
                future.set_result(None)
        self.sleeping.clear()
        for _ in range(5):
            await asyncio.sleep(0)


def test_a_burst_of_writes_exports_once() -> None:
    async def scenario() -> int:
        calls = 0

        async def export() -> dict:
            nonlocal calls
            calls += 1
            return {"written": True}

        clock = FakeClock()
        debouncer = SnapshotDebouncer(export, delay=30, sleep=clock.sleep)
        for _ in range(3):
            debouncer.schedule()
            await asyncio.sleep(0)
        assert calls == 0 and debouncer.pending
        await clock.advance()
        assert not debouncer.pending
        debouncer.schedule()  # una escritura posterior programa otra
        await asyncio.sleep(0)
        await clock.advance()
        return calls

    assert asyncio.run(scenario()) == 2


def test_flush_exports_now_and_cancels_the_pending_one() -> None:
    async def scenario() -> tuple[int, dict]:
        calls = 0

        async def export() -> dict:
            nonlocal calls
            calls += 1
            return {"written": calls == 1, "businesses": 1, "nodes": 3}

        clock = FakeClock()
        debouncer = SnapshotDebouncer(export, delay=30, sleep=clock.sleep)
        debouncer.schedule()
        await asyncio.sleep(0)
        result = await debouncer.flush()
        await clock.advance()
        return calls, result

    calls, result = asyncio.run(scenario())
    assert calls == 1 and result["written"] is True


def test_a_failed_export_does_not_raise(caplog) -> None:
    async def scenario() -> None:
        async def export() -> dict:
            raise RuntimeError("disk full: secret path")

        clock = FakeClock()
        debouncer = SnapshotDebouncer(export, delay=30, sleep=clock.sleep)
        debouncer.schedule()
        await asyncio.sleep(0)
        await clock.advance()

    asyncio.run(scenario())
    assert "RuntimeError" in caplog.text and "secret path" not in caplog.text


def test_brain_snapshot_flush_is_ale_only_and_reports_written(tmp_path) -> None:
    (tmp_path / "opt" / "saleads" / "seed").mkdir(parents=True)
    (tmp_path / "opt" / "saleads" / "seed" / "seed.json").write_text(json.dumps(SEED))
    settings = load({"BRAIN_DATA": str(tmp_path / "brain"), "HERMES_DATA": str(tmp_path / "opt"), "BRAIN_PORT": "8765",
                     "BRAIN_ALE_TOKEN": "ale-secret-token"})
    brain = Brain(settings, InMemoryStore(), Ledger(tmp_path / "l.db"))
    app = create_server(brain).streamable_http_app()
    with TestClient(app, base_url="http://saleads-brain:8765") as client:
        assert client.post("/run/ingest-seed").json()["ok"]
        assert call(client, "brain_snapshot_flush", {}, None) == {"accepted": False, "reason": "profile_not_allowed"}
        first = call(client, "brain_snapshot_flush", {}, "ale-secret-token")
        assert first["written"] is True and first["businesses"] == 1 and first["nodes"] >= 8
        assert call(client, "brain_snapshot_flush", {}, "ale-secret-token")["written"] is False
        fact = {"business_id": BUSINESS, "path": "audiencia.ideal_client", "value": "Mamás que trabajan",
                "provenance": "owner_said", "evidence": "lo dijo en el chat"}
        assert call(client, "brain_record_fact", fact, "ale-secret-token")["accepted"] is True
        assert call(client, "brain_snapshot_flush", {}, "ale-secret-token")["written"] is True
    assert (tmp_path / "opt" / "saleads" / "graph" / "snapshot.json.gz").exists()
