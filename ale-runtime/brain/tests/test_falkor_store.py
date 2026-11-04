"""FalkorStore escribe aristas que Graphiti puede leer (laboratorio capa 1, 2026-10-27)."""

from typing import Any

import pytest

from saleads_brain import search as words
from saleads_brain.graph import FALLBACK_MODE, FULLTEXT_ADD_FIELD, FULLTEXT_DDL, Edge, FalkorStore, Node


class _Graph:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def query(self, cypher: str, params: dict[str, Any]) -> None:
        self.calls.append((cypher, params))


def _store(graph: _Graph) -> FalkorStore:
    store = FalkorStore.__new__(FalkorStore)
    store._graph = lambda _group: graph  # type: ignore[method-assign]
    return store


def test_seed_edges_carry_the_fields_graphiti_requires() -> None:
    graph = _Graph()
    store = _store(graph)
    store.upsert_edge("b_x", Edge(source="a", target="b", name="OFFERS", fact="vende"))
    store.upsert_edge("b_x", Edge(source="a", target="b", name="OFFERS", fact="vende"))
    cypher, params = graph.calls[0]
    for field in ("r.uuid", "r.created_at", "r.episodes", "r.source_node_uuid", "r.target_node_uuid"):
        assert field in cypher
    assert params["uuid"] and params["uuid"] == graph.calls[1][1]["uuid"]
    assert params["created_at"]


def test_falkor_attributes_are_flat_and_primitive() -> None:
    """Laboratorio capa 1: el modelo a veces envuelve los atributos en {"attributes": {...}} y
    Graphiti los copia como mapa; FalkorDB solo acepta primitivos o listas de primitivos."""
    from saleads_brain.graph import falkor_safe_attributes

    out = falkor_safe_attributes(
        {"attributes": {"industry_code": "beauty", "attributes_json": "{}"}, "display_name": "x", "tags": ["a", "b"],
         "meta": {"k": 1}, "mixed": [{"a": 1}], "count": 3}
    )
    assert out == {"industry_code": "beauty", "display_name": "x", "tags": ["a", "b"], "meta": '{"k": 1}',
                   "mixed": '[{"a": 1}]', "count": 3}
    assert falkor_safe_attributes({"attributes": {}}) == {}


def test_forgetting_half_written_episodes_targets_only_those_sessions() -> None:
    """Un lote que falla a medias deja episodios; el reintento los borra primero (sin duplicados)."""
    graph = _Graph()
    _store(graph).forget_episodes("b_x", ["session-s1", "session-s2"])
    cypher, params = graph.calls[0]
    assert "Episodic" in cypher and "DETACH DELETE" in cypher and "group_id" in cypher
    assert params == {"group": "b_x", "names": ["session-s1", "session-s2"]}


def test_adapter_is_called_the_way_graphiti_calls_it(monkeypatch) -> None:
    import asyncio
    from types import SimpleNamespace

    import graphiti_core.graphiti as graphiti_module

    from saleads_brain import graph

    seen: dict[str, Any] = {}

    async def fake_bulk(**kwargs: Any) -> None:
        seen.update(kwargs)

    monkeypatch.setattr(graphiti_module, "add_nodes_and_edges_bulk", fake_bulk)
    graph._install_falkor_adapter()
    node = SimpleNamespace(attributes={"attributes": {"industry_code": "beauty"}})
    asyncio.run(graphiti_module.add_nodes_and_edges_bulk(  # type: ignore[attr-defined]
        driver=None, episodic_nodes=[], episodic_edges=[], entity_nodes=[node], entity_edges=[], embedder=None))
    assert seen["entity_nodes"][0].attributes == {"industry_code": "beauty"}


def test_edges_written_by_an_older_image_are_completed() -> None:
    """Dev 2026-10-28: aristas de la semilla vieja sin uuid hacían fallar todo lote."""

    class _Result:
        result_set = [[7, "src", "dst", "SELLS"]]

    class _RepairGraph(_Graph):
        def query(self, cypher: str, params: dict[str, Any]) -> Any:  # type: ignore[override]
            self.calls.append((cypher, params))
            return _Result() if "RETURN id(r)" in cypher else None

    graph = _RepairGraph()
    assert _store(graph).repair_edges("b_x") == 1
    cypher, params = graph.calls[1]
    for field in ("r.uuid", "r.created_at", "r.episodes", "r.source_node_uuid", "r.target_node_uuid"):
        assert field in cypher
    assert params["rid"] == 7 and params["source"] == "src" and params["target"] == "dst" and params["uuid"]


# ------------------------------------------------- MCB-009: índice de texto completo y búsqueda sin modelo


class _Rows:
    def __init__(self, rows: list[Any]) -> None:
        self.result_set = rows


def _row(uuid: str, name: str, summary: str, **loop: Any) -> list[Any]:
    return [uuid, ["Entity", "Decision"], name, summary, "owner_decided", "HUMAN_VALIDATED", "2026-10-31", 0, loop]


class _SearchGraph:
    """FalkorDB falso: escrituras por `query`, lecturas por `ro_query` (una lectura no crea el grafo)."""

    def __init__(self, fulltext: list[Any] | Exception, nodes: list[Any] | None = None,
                 ddl_error: Exception | None = None, add_error: Exception | None = None) -> None:
        self.fulltext, self.rows, self.ddl_error, self.add_error = fulltext, nodes or [], ddl_error, add_error
        self.writes: list[tuple[str, dict[str, Any]]] = []
        self.reads: list[tuple[str, dict[str, Any]]] = []

    def query(self, cypher: str, params: dict[str, Any] | None = None) -> Any:
        self.writes.append((cypher, params or {}))
        if cypher == FULLTEXT_DDL and self.ddl_error:
            raise self.ddl_error
        if cypher == FULLTEXT_ADD_FIELD and self.add_error:
            raise self.add_error
        if "search_text IS NULL" in cypher:
            return _Rows([["old", "Decisión", "aprobó el presupuesto"]])
        return None

    def ro_query(self, cypher: str, params: dict[str, Any]) -> Any:
        self.reads.append((cypher, params))
        if "queryNodes" in cypher:
            if isinstance(self.fulltext, Exception):
                raise self.fulltext
            return _Rows(self.fulltext)
        return _Rows(self.rows)


def _search_store(graph: _SearchGraph) -> FalkorStore:
    store = FalkorStore.__new__(FalkorStore)
    store._graph = lambda _group: graph  # type: ignore[method-assign]
    return store


def test_query_text_sent_to_falkordb_has_no_accents_marks_or_stopwords() -> None:
    graph = _SearchGraph([_row("d1", "Decisión", "Hernán reparte el presupuesto por mitades")])
    nodes, mode = _search_store(graph).search("b_x", words.terms("¿qué presupuesto aprobó?"), 5)
    cypher, params = graph.reads[0]
    assert params == {"q": "(presupuesto | aprobo)", "limit": 5}
    assert "CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score" in cypher
    assert "ORDER BY score DESC, node.created_at DESC" in cypher
    assert mode == "palabras" and nodes[0].uuid == "d1" and nodes[0].type_name == "Decision"
    # Los separadores de FalkorDB nunca llegan a la consulta (no hay nada que escapar).
    assert words.fulltext_query(words.terms('precio "novia" (2026) | -x* @group')) == "(precio | novia | 2026 | x | group)"


def test_index_is_created_once_per_graph_with_graphiti_ddl_plus_search_text() -> None:
    graph = _SearchGraph([])
    store = _search_store(graph)
    store.search("b_x", ["presupuesto"], 5)
    store.search("b_x", ["margen"], 5)
    ddl = [c for c, _ in graph.writes if "CREATE FULLTEXT INDEX" in c]
    assert ddl == [FULLTEXT_DDL]
    assert "ON (n.name, n.summary, n.group_id, n.search_text)" in FULLTEXT_DDL and "stopwords: ['a', 'is'" in FULLTEXT_DDL
    # Los nodos viejos (escritos por Graphiti) reciben su search_text sin tildes, una vez.
    fills = [p for c, p in graph.writes if "SET n.search_text" in c]
    assert fills == [{"uuid": "old", "text": "decision aprobo el presupuesto"}]


def test_existing_graphiti_index_is_success_and_only_search_text_is_added() -> None:
    graph = _SearchGraph([], ddl_error=RuntimeError("Attribute 'name' is already indexed"))
    store = _search_store(graph)
    assert store.ensure_fulltext("b_x") is True
    assert [c for c, _ in graph.writes if "CREATE FULLTEXT" in c] == [FULLTEXT_DDL, FULLTEXT_ADD_FIELD]
    graph2 = _SearchGraph([], ddl_error=RuntimeError("already indexed"), add_error=RuntimeError("already exists"))
    assert _search_store(graph2).ensure_fulltext("b_x") is True


@pytest.mark.parametrize("fulltext", [RuntimeError("index does not exist"), []])
def test_missing_or_building_index_answers_by_counting_terms_not_empty(fulltext) -> None:
    """Regla: un índice que falta o se está construyendo nunca se muestra como «sin coincidencias»."""
    rows = [_row("d1", "Decisión", "Hernán reparte el presupuesto por mitades"), _row("o1", "Oferta", "Sérum facial")]
    nodes, mode = _search_store(_SearchGraph(fulltext, rows)).search("b_x", ["presupuesto"], 5)
    assert mode == FALLBACK_MODE and [n.uuid for n in nodes] == ["d1"]


def test_unknown_ddl_error_falls_back_without_visible_errors() -> None:
    graph = _SearchGraph([_row("x", "n", "s")], nodes=[_row("d1", "Decisión", "presupuesto")],
                         ddl_error=RuntimeError("Invalid input"))
    nodes, mode = _search_store(graph).search("b_x", ["presupuesto"], 5)
    assert mode == FALLBACK_MODE and nodes[0].uuid == "d1" and not [c for c, _ in graph.reads if "queryNodes" in c]


def test_upsert_writes_search_text_and_the_saleads_bet_id_survives_as_a_property() -> None:
    graph = _SearchGraph([])
    _search_store(graph).upsert_node("b_x", Node(uuid="b1", type_name="Bet", name="Apuesta v1: Mamás", summary="Rutina rápida",
                                                 attributes={"stage": "en_prueba", "saleads_bet_id": "abc"}))
    cypher, params = graph.writes[0]
    assert "n.search_text=$search_text" in cypher and params["search_text"] == "apuesta v1 mamas rutina rapida"
    assert params["loop"]["saleads_bet_id"] == "abc"
    from saleads_brain.graph import _node_of

    row = ["b1", ["Entity", "Bet"], "Apuesta", "", "inferred", "PROPOSED", "", 0, {"saleads_bet_id": "abc", "stage": None}]
    assert _node_of(row).attributes == {"saleads_bet_id": "abc"}


def test_brain_query_with_a_foreign_id_never_touches_its_graph(tmp_path) -> None:
    """Regla (F6): con FalkorDB real, una consulta a un grafo inexistente lo crea. El rechazo es antes."""
    import json

    from fixtures_seed import BUSINESS, SEED
    from starlette.testclient import TestClient
    from test_server import call

    from saleads_brain.app import Brain
    from saleads_brain.ledger import Ledger
    from saleads_brain.server import create_server
    from saleads_brain.settings import group_id, load

    touched: list[str] = []
    graph = _SearchGraph([])

    class _Db:
        def list_graphs(self) -> list[str]:
            return [group_id(BUSINESS)]

    store = FalkorStore.__new__(FalkorStore)
    store._db = _Db()

    def select(group: str) -> Any:
        touched.append(group)
        return graph

    store._graph = select  # type: ignore[method-assign]
    (tmp_path / "opt" / "saleads" / "seed").mkdir(parents=True)
    (tmp_path / "opt" / "saleads" / "seed" / "seed.json").write_text(json.dumps(SEED))
    settings = load({"BRAIN_DATA": str(tmp_path / "brain"), "HERMES_DATA": str(tmp_path / "opt"), "BRAIN_PORT": "8765"})
    brain = Brain(settings, store, Ledger(tmp_path / "l.db"))
    typo = BUSINESS[:-1] + ("0" if BUSINESS[-1] != "0" else "1")
    with TestClient(create_server(brain).streamable_http_app(), base_url="http://saleads-brain:8765") as client:
        out = call(client, "brain_query", {"business_id": typo, "query": "precio"})
        call(client, "brain_ingest", {"business_id": typo, "text": "Mi margen es 35 %"})
        call(client, "brain_query", {"business_id": BUSINESS, "query": "precio"})
    assert out["reason"].startswith("negocio_desconocido") and touched and set(touched) == {group_id(BUSINESS)}
