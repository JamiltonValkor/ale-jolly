"""First seed must not read a nonexistent Falkor graph before its first write."""

import sqlite3
from pathlib import Path

import pytest

from saleads_brain.graph import FalkorStore, InMemoryStore, Node
from saleads_brain.ledger import Ledger
from saleads_brain.seed import SeedLoader
from saleads_brain.settings import group_id

BUSINESS = "7c83995a-6023-4600-a7cd-60d913961c64"
GROUP = group_id(BUSINESS)
PAYLOAD = {
    "schema_version": "saleads-business-bootstrap/2",
    "business_id": BUSINESS,
    "generated_at": "2026-10-31T00:00:00Z",
    "context": {"facts": {"business": {"name": "Synthetic business"}}},
}


class MissingGraphError(RuntimeError):
    pass


class MissingGraph:
    def ro_query(self, *_args: object) -> None:
        raise MissingGraphError("Invalid graph operation on empty key")


class FirstReadStore(InMemoryStore):
    """Memory writes plus the real Falkor read adapter at the missing-key boundary."""

    def __init__(self, existing: tuple[str, ...] = ()) -> None:
        super().__init__()
        self.existing = set(existing)
        self.operations: list[tuple[str, str]] = []
        self.read_error = False

    def groups(self) -> list[str]:
        return sorted(self.existing | set(super().groups()))

    def nodes(self, group: str, limit: int) -> list[Node]:
        self.operations.append(("read", group))
        if group not in self.groups():
            # Run the production nodes -> _read -> GRAPH.RO_QUERY path;
            # no Redis server, network or parser reimplementation is needed.
            adapter = FalkorStore.__new__(FalkorStore)
            adapter._graph = lambda _group: MissingGraph()  # type: ignore[method-assign]
            return adapter.nodes(group, limit)
        if self.read_error:
            raise RuntimeError("existing_graph_unavailable")
        return super().nodes(group, limit)

    def upsert_node(self, group: str, node: Node) -> None:
        self.operations.append(("write", group))
        self.existing.add(group)
        super().upsert_node(group, node)


def event_counts(path: Path) -> tuple[int, int]:
    with sqlite3.connect(path) as db:
        return (
            db.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
        )


def test_first_seed_writes_before_reading_new_graph_and_repeats_once(tmp_path: Path) -> None:
    store = FirstReadStore()
    path = tmp_path / "ledger.db"
    loader = SeedLoader(store, Ledger(path))

    first = loader.load_business(PAYLOAD)
    assert store.operations[0] == ("write", GROUP)
    assert first["nodes"] == 1 and first["retired"] == 0
    second = loader.load_business(PAYLOAD)
    assert second["nodes"] == 1 and len(store.nodes(GROUP, 100)) == 1
    assert event_counts(path) == (1, 1)


def test_existing_empty_graph_is_read_during_retirement(tmp_path: Path) -> None:
    store = FirstReadStore((GROUP,))
    result = SeedLoader(store, Ledger(tmp_path / "ledger.db")).load_business(PAYLOAD)
    assert store.operations[0] == ("read", GROUP)
    assert result["retired"] == 0 and result["nodes"] == 1


def test_existing_seed_migration_preserves_conversation_and_other_business(tmp_path: Path) -> None:
    store = FirstReadStore()
    store.upsert_node(GROUP, Node(uuid="old", type_name="Hypothesis", name="old seeded hypothesis"))
    store.upsert_node(GROUP, Node(uuid="owner", type_name="Hypothesis", name="owner note", provenance="conversation"))
    foreign = group_id("46f4bb64-a562-4c45-a922-c725ba93d977")
    store.upsert_node(foreign, Node(uuid="foreign", type_name="Hypothesis", name="other business"))
    store.operations.clear()
    path = tmp_path / "ledger.db"
    loader = SeedLoader(store, Ledger(path))

    first = loader.load_business(PAYLOAD)
    second = loader.load_business(PAYLOAD)
    assert first["retired"] == 1 and second["retired"] == 0
    assert store.operations[0] == ("read", GROUP)
    assert {node.uuid for node in store.nodes(GROUP, 100)} >= {"owner"}
    assert store.node(GROUP, "old") is None
    assert store.node(foreign, "foreign") is not None
    assert not any(group == foreign for _operation, group in store.operations)
    assert event_counts(path) == (1, 1)


def test_existing_graph_failures_are_not_swallowed(tmp_path: Path) -> None:
    store = FirstReadStore((GROUP,))
    store.read_error = True
    with pytest.raises(RuntimeError, match="existing_graph_unavailable"):
        SeedLoader(store, Ledger(tmp_path / "ledger.db")).load_business(PAYLOAD)
    assert store.operations == [("read", GROUP)]
