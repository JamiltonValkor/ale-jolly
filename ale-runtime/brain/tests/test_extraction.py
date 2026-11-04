"""Lo que el cerebro le pide a Graphiti (laboratorio capa 1, L1-07 y L1-13)."""

import asyncio
from typing import Any

from saleads_brain.app import Brain
from saleads_brain.day import Episode
from saleads_brain.graph import InMemoryStore
from saleads_brain.ledger import Ledger
from saleads_brain.settings import load

BUSINESS = "00000000-0000-4000-8000-000000000002"


class _FakeGraphiti:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def add_episode_bulk(self, episodes: list[Any], **kwargs: Any) -> None:
        self.calls.append({"episodes": episodes, **kwargs})


def test_episodes_reach_the_ai_without_contact_data_and_with_spanish_rules(tmp_path) -> None:
    settings = load({"BRAIN_DATA": str(tmp_path), "HERMES_DATA": str(tmp_path), "OPENROUTER_API_KEY": "k"})
    brain = Brain(settings, InMemoryStore(), Ledger(tmp_path / "l.db"))
    fake = _FakeGraphiti()
    brain._graphiti = fake
    text = "Dueño: mi clienta Laura, 3001234567, laura.gomez@gmail.com, vive en Calle 85 #11-20"
    asyncio.run(brain._add_batch(BUSINESS, [Episode("s1", 7, 1_760_000_000.0, text, [text])]))
    call = fake.calls[0]
    content = call["episodes"][0].content
    for leaked in ("3001234567", "laura.gomez@gmail.com", "Calle 85 #11-20"):
        assert leaked not in content
    rules = call["custom_extraction_instructions"]
    assert "español" in rules and "Dueño" in rules and "nombre propio" in rules


class _Embedder:
    async def create_batch(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(t))] for t in texts]


class _SeedStore(InMemoryStore):
    def __init__(self) -> None:
        super().__init__()
        self.missing = {"b_x": ([("n1", "Paquete de novia completo")], [("e1", "Precio registrado en SaleADS")])}
        self.saved: list[tuple[str, str, str, list[float]]] = []

    def missing_embeddings(self, group: str) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
        return self.missing.get(group, ([], []))

    def groups(self) -> list[str]:
        return ["b_x"]

    def set_embedding(self, group: str, kind: str, uuid: str, vector: list[float]) -> None:
        self.saved.append((group, kind, uuid, vector))


def test_seed_gets_embeddings_so_graphiti_recognizes_it(tmp_path) -> None:
    """Laboratorio L1-03: sin embedding, Graphiti no encuentra el nodo sembrado y lo duplica."""
    settings = load({"BRAIN_DATA": str(tmp_path), "HERMES_DATA": str(tmp_path), "OPENROUTER_API_KEY": "k"})
    store = _SeedStore()
    brain = Brain(settings, store, Ledger(tmp_path / "l.db"))
    brain._graphiti = type("G", (), {"embedder": _Embedder()})()
    result = asyncio.run(brain.embed_seed())
    assert result == {"embedded": 2}
    assert store.saved == [("b_x", "node", "n1", [25.0]), ("b_x", "edge", "e1", [28.0])]


def test_third_party_names_are_masked_before_the_ai() -> None:
    """Laboratorio L1-07 (ronda 2): con la instrucción, el modelo aún guardaba «Laura Gómez»."""
    from saleads_brain.privacy import redact_people

    text = "Dueño: ayer vino Laura Gómez y Andrés Pérez el repartidor; en Glamour Novias el Combo Rayo no aplica"
    out = redact_people(text, keep=["Glamour Novias", "Combo Rayo"])
    assert "Laura Gómez" not in out and "Andrés Pérez" not in out
    assert "Glamour Novias" in out and "Combo Rayo" in out
    assert redact_people("Instagram y WhatsApp funcionan", keep=[]) == "Instagram y WhatsApp funcionan"


def test_the_ai_cannot_write_provenance() -> None:
    """Laboratorio L1-02: el modelo escribía la procedencia («inferred», «Medellín, Colombia»)."""
    from saleads_brain.ontology import ontology_for_event

    entities, _ = ontology_for_event("business_profile", None)
    for model in entities.values():
        assert "provenance" not in model.model_fields and "verification" not in model.model_fields


def test_every_ai_call_asks_for_spanish() -> None:
    """Laboratorio (ronda 3): los resúmenes de Graphiti salían en inglés (su prompt no recibe nuestras reglas)."""
    from graphiti_core.prompts.models import Message

    from saleads_brain.graph import with_spanish

    messages = with_spanish([Message(role="system", content="You are a helpful assistant."), Message(role="user", content="x")])
    assert "español" in messages[0].content and messages[0].content.startswith("You are a helpful assistant.")
    assert messages[1].content == "x"


def test_graph_nodes_without_provenance_are_conversation(tmp_path) -> None:
    from saleads_brain.graph import DEFAULT_PROVENANCE

    assert DEFAULT_PROVENANCE == "conversation"
