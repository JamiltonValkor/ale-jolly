"""Acceso al grafo del negocio.

- `GraphStore`: escrituras deterministas (semilla, sin IA) y lecturas para la
  foto. Sigue la convención de Graphiti: nodos `:Entity:<Tipo>` con `uuid`,
  `name`, `summary`, `group_id`; relaciones `:RELATES_TO {name, fact}`.
- `search`: búsqueda por palabras sin modelo (MCB-009): índice de texto completo de FalkorDB
  (BM25) y, si el índice falta o se está construyendo, conteo de términos sobre los nodos.
- `graphiti_for`: Graphiti sobre FalkorDB con la key del dueño (OpenRouter), para la extracción
  diaria. Inalcanzable desde MCB-009 (D16: `llm_enabled` es siempre False); queda para una mejora futura.
"""

from __future__ import annotations

import json
import uuid as uuidlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from saleads_brain import search as words
from saleads_brain.ledger import stable_id
from saleads_brain.settings import OPENROUTER_BASE, Settings


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class Node:
    uuid: str
    type_name: str
    name: str
    summary: str = ""
    provenance: str = "saleads_seed"
    verification: str = "SYSTEM_VERIFIED"
    created_at: str = field(default_factory=now_iso)
    attributes: dict[str, Any] = field(default_factory=dict)
    mentions: int = 0


@dataclass(slots=True)
class Edge:
    source: str
    target: str
    name: str
    fact: str = ""
    provenance: str = "saleads_seed"
    valid_at: str | None = None
    invalid_at: str | None = None


# Atributos del loop guardados como propiedades de primer nivel (MLB-009): Graphiti guarda con
# `SET n = node` y el adaptador descarta `attributes_json`; así sobreviven a la extracción.
LOOP_PROPS = (
    "canonical_id",
    "confidence",
    "evidence_count",
    "valid_from",
    "valid_to",
    "learned_at",
    "stage",
    "scope",
    "outcome",
    "round",
    "read_at",
    "spend",
    "purchases",
    "leads",
    "cpa",
    "window_days",
    "revision_id",
    "last_evidence_at",
    "decayed_at",
    # MCB-008: el `bet_id` de SaleADS (communication_hypothesis_id) unido al nodo Bet con brain_link_bet.
    "saleads_bet_id",
    # MCB-009: la cita literal del dueño y lo que Ale entendió de ella (Decision, OwnerNote).
    "owner_quote",
    "interpretation",
)

SEARCH_MODE = "palabras"
FALLBACK_MODE = "palabras_respaldo"
FALLBACK_POOL = 500


class GraphStore(Protocol):
    def upsert_node(self, group: str, node: Node) -> None: ...
    def node(self, group: str, uuid: str) -> Node | None: ...
    def edges_of(self, group: str, uuid: str) -> list[Edge]: ...
    def delete_node(self, group: str, uuid: str) -> None: ...
    def episodes_of(self, group: str, uuid: str) -> list[tuple[str, str]]: ...
    def delete_edge(self, group: str, edge: Edge) -> None: ...
    def upsert_edge(self, group: str, edge: Edge) -> None: ...
    def nodes(self, group: str, limit: int) -> list[Node]: ...
    def edges(self, group: str, limit: int) -> list[Edge]: ...
    def groups(self) -> list[str]: ...
    def forget_episodes(self, group: str, names: list[str]) -> None: ...
    def repair_edges(self, group: str) -> int: ...
    def search(self, group: str, terms: list[str], limit: int) -> tuple[list[Node], str]:
        """Nodos que mejor coinciden con los términos (ya normalizados) y el modo usado."""
        ...


class InMemoryStore:
    """Store de pruebas con la misma semántica que FalkorStore."""

    def __init__(self) -> None:
        self._nodes: dict[str, dict[str, Node]] = {}
        self._edges: dict[str, dict[tuple[str, str, str], Edge]] = {}
        # Episodios que mencionan cada nodo (uuid del episodio, fuente): lo escribe Graphiti en FalkorDB.
        self.episodes: dict[str, dict[str, list[tuple[str, str]]]] = {}

    def episodes_of(self, group: str, uuid: str) -> list[tuple[str, str]]:
        return list(self.episodes.get(group, {}).get(uuid, []))

    def upsert_node(self, group: str, node: Node) -> None:
        self._nodes.setdefault(group, {})[node.uuid] = node

    def forget_episodes(self, group: str, names: list[str]) -> None:
        """Sin episodios en memoria (Graphiti solo escribe en FalkorDB)."""

    def repair_edges(self, group: str) -> int:
        """En memoria toda arista nace completa."""
        return 0

    def upsert_edge(self, group: str, edge: Edge) -> None:
        self._edges.setdefault(group, {})[(edge.source, edge.target, edge.name)] = edge

    def node(self, group: str, uuid: str) -> Node | None:
        return self._nodes.get(group, {}).get(uuid)

    def edges_of(self, group: str, uuid: str) -> list[Edge]:
        return [e for e in self._edges.get(group, {}).values() if uuid in (e.source, e.target)]

    def delete_node(self, group: str, uuid: str) -> None:
        self._nodes.get(group, {}).pop(uuid, None)
        edges = self._edges.get(group, {})
        for key in [k for k, e in edges.items() if uuid in (e.source, e.target)]:
            del edges[key]

    def delete_edge(self, group: str, edge: Edge) -> None:
        self._edges.get(group, {}).pop((edge.source, edge.target, edge.name), None)

    def nodes(self, group: str, limit: int) -> list[Node]:
        return list(self._nodes.get(group, {}).values())[:limit]

    def edges(self, group: str, limit: int) -> list[Edge]:
        return list(self._edges.get(group, {}).values())[:limit]

    def groups(self) -> list[str]:
        return sorted(set(self._nodes) | set(self._edges))

    def search(self, group: str, terms: list[str], limit: int) -> tuple[list[Node], str]:
        return words.rank(self._nodes.get(group, {}).values(), terms, limit), SEARCH_MODE


def _props(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


class FalkorStore:
    """GraphStore sobre FalkorDB (un grafo por negocio)."""

    def __init__(self, host: str, port: int) -> None:
        from falkordb import FalkorDB

        self._db = FalkorDB(host=host, port=port)

    def _graph(self, group: str) -> Any:
        return self._db.select_graph(group)

    def _read(self, group: str, cypher: str, params: dict[str, Any]) -> list[Any]:
        """Lecturas con GRAPH.RO_QUERY: una lectura nunca debe crear un grafo (MCB-009, F6)."""
        result = self._graph(group).ro_query(cypher, params)
        return list(getattr(result, "result_set", None) or [])

    def ensure_fulltext(self, group: str) -> bool:
        """Índice de texto completo de `:Entity`, una vez por grafo y proceso (MCB-009).

        Sin LLM, Graphiti ya no lo crea: el cerebro es su dueño. Es la DDL de Graphiti 0.31.1
        (`graph_queries.py:97-99`, sin idioma y con sus palabras vacías) más `search_text`, para que los
        grafos viejos y los nuevos se comporten igual. Si el índice ya existe (lo creó Graphiti), solo se suma
        `search_text`. Un «ya existe» o «ya indexado» es éxito. Después completa `search_text` en los nodos
        que no lo tienen (los que escribió Graphiti o una imagen anterior), sin tocar nada más.
        """
        indexed: set[str] = self.__dict__.setdefault("_indexed", set())
        if group in indexed:
            return True
        graph = self._graph(group)
        try:
            graph.query(FULLTEXT_DDL)
        except Exception as error:  # noqa: BLE001 - FalkorDB responde con ResponseError de redis
            if not _already_indexed(error):
                return False
            try:
                graph.query(FULLTEXT_ADD_FIELD)
            except Exception as again:  # noqa: BLE001 - idem
                if not _already_indexed(again):
                    return False
        indexed.add(group)
        result = graph.query(
            "MATCH (n:Entity) WHERE n.search_text IS NULL RETURN n.uuid, n.name, n.summary LIMIT 5000", {}
        )
        for uuid, name, summary in getattr(result, "result_set", None) or []:
            graph.query(
                "MATCH (n:Entity {uuid: $uuid}) SET n.search_text = $text",
                {"uuid": uuid, "text": words.search_text(str(name or ""), str(summary or ""))},
            )
        return True

    def search(self, group: str, terms: list[str], limit: int) -> tuple[list[Node], str]:
        """`db.idx.fulltext.queryNodes` (BM25). Si el índice no existe, falla o todavía no devuelve nada
        (se está construyendo), cuenta términos sobre los nodos: nunca muestra «sin coincidencias» por un
        índice a medio construir."""
        query = words.fulltext_query(terms)
        if not query:
            return [], SEARCH_MODE
        rows: list[Any] | None = None
        if self.ensure_fulltext(group):
            try:
                rows = self._read(
                    group,
                    "CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score "
                    "RETURN node.uuid, labels(node), node.name, node.summary, node.provenance, node.verification, "
                    f"node.created_at, 0, {_loop_map('node')} ORDER BY score DESC, node.created_at DESC LIMIT $limit",
                    {"q": query, "limit": limit},
                )
            except Exception:  # noqa: BLE001 - sin índice o en construcción: se responde con el respaldo
                rows = None
        if rows:
            return [_node_of(row) for row in rows], SEARCH_MODE
        fallback = words.rank(self.nodes(group, FALLBACK_POOL), terms, limit)
        return fallback, (FALLBACK_MODE if fallback or rows is None else SEARCH_MODE)

    def upsert_node(self, group: str, node: Node) -> None:
        label = node.type_name if node.type_name.isidentifier() else "Entity"
        loop = {key: _falkor_value(node.attributes[key]) for key in LOOP_PROPS if key in node.attributes}
        self._graph(group).query(
            f"MERGE (n:Entity {{uuid: $uuid}}) SET n:{label}, n.name=$name, n.summary=$summary, "
            "n.group_id=$group, n.provenance=$provenance, n.verification=$verification, "
            "n.created_at=coalesce(n.created_at, $created_at), n.attributes_json=$attributes, "
            "n.search_text=$search_text SET n += $loop",
            {
                "search_text": words.search_text(node.name, node.summary),
                "loop": loop,
                "uuid": node.uuid,
                "name": node.name,
                "summary": node.summary,
                "group": group,
                "provenance": node.provenance,
                "verification": node.verification,
                "created_at": node.created_at,
                "attributes": _props(node.attributes),
            },
        )
        self.ensure_fulltext(group)

    def missing_embeddings(self, group: str) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
        """Nodos y aristas sin embedding (los de la semilla): (uuid, texto a embeber)."""
        graph = self._graph(group)
        nodes = graph.query(
            "MATCH (n:Entity) WHERE n.name_embedding IS NULL AND n.name IS NOT NULL RETURN n.uuid, n.name LIMIT 500"
        ).result_set
        edges = graph.query(
            "MATCH ()-[r:RELATES_TO]->() WHERE r.fact_embedding IS NULL AND r.uuid IS NOT NULL "
            "RETURN r.uuid, coalesce(r.fact, r.name) LIMIT 2000"
        ).result_set
        return [(str(u), str(t)) for u, t in nodes if t], [(str(u), str(t)) for u, t in edges if t]

    def set_embedding(self, group: str, kind: str, uuid: str, vector: list[float]) -> None:
        if kind == "node":
            query = "MATCH (n:Entity {uuid: $uuid}) SET n.name_embedding = vecf32($vector)"
        else:
            query = "MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() SET r.fact_embedding = vecf32($vector)"
        self._graph(group).query(query, {"uuid": uuid, "vector": vector})

    def forget_episodes(self, group: str, names: list[str]) -> None:
        """Borra los episodios de esas sesiones antes de (re)intentar un lote: FalkorDB no tiene
        transacciones y un lote que falla a medias los deja escritos."""
        self._graph(group).query(
            "MATCH (e:Episodic) WHERE e.group_id = $group AND e.name IN $names DETACH DELETE e",
            {"group": group, "names": names},
        )

    def upsert_edge(self, group: str, edge: Edge) -> None:
        # Graphiti lee estas aristas como EntityEdge: exige uuid, created_at, episodes y
        # los uuid de origen y destino (sin ellos, todo lote que las toca falla).
        self._graph(group).query(
            "MATCH (a:Entity {uuid: $source}), (b:Entity {uuid: $target}) "
            "MERGE (a)-[r:RELATES_TO {name: $name}]->(b) "
            "SET r.fact=$fact, r.group_id=$group, r.provenance=$provenance, r.valid_at=$valid_at, "
            "r.uuid=coalesce(r.uuid, $uuid), r.created_at=coalesce(r.created_at, $created_at), "
            "r.episodes=coalesce(r.episodes, []), r.source_node_uuid=$source, r.target_node_uuid=$target",
            {
                "source": edge.source,
                "target": edge.target,
                "name": edge.name,
                "fact": edge.fact,
                "group": group,
                "provenance": edge.provenance,
                "valid_at": edge.valid_at,
                "uuid": str(uuidlib.UUID(stable_id(group, edge.source, edge.name, edge.target))),
                "created_at": now_iso(),
            },
        )

    def repair_edges(self, group: str) -> int:
        """Completa las aristas que escribió una imagen anterior sin los campos que Graphiti
        exige (dev 2026-10-27: sin esto, todo lote que las toca falla aunque se resiembre)."""
        graph = self._graph(group)
        result = graph.query(
            "MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) "
            "WHERE r.uuid IS NULL OR r.created_at IS NULL OR r.episodes IS NULL "
            "RETURN id(r), a.uuid, b.uuid, r.name",
            {},
        )
        rows = getattr(result, "result_set", None) or []
        for rid, source, target, name in rows:
            graph.query(
                "MATCH ()-[r]->() WHERE id(r) = $rid "
                "SET r.uuid=coalesce(r.uuid, $uuid), r.created_at=coalesce(r.created_at, $created_at), "
                "r.episodes=coalesce(r.episodes, []), r.group_id=coalesce(r.group_id, $group), "
                "r.fact=coalesce(r.fact, ''), r.source_node_uuid=$source, r.target_node_uuid=$target",
                {
                    "rid": rid,
                    "uuid": str(uuidlib.UUID(stable_id(group, source, name or "", target))),
                    "created_at": now_iso(),
                    "group": group,
                    "source": source,
                    "target": target,
                },
            )
        return len(rows)

    def nodes(self, group: str, limit: int) -> list[Node]:
        rows = self._read(
            group,
            "MATCH (n:Entity) OPTIONAL MATCH (e:Episodic)-[:MENTIONS]->(n) "
            "WITH n, count(e) AS mentions RETURN n.uuid, labels(n), n.name, n.summary, "
            f"n.provenance, n.verification, n.created_at, mentions, {_LOOP_MAP} "
            "ORDER BY mentions DESC LIMIT $limit",
            {"limit": limit},
        )
        return [_node_of(row) for row in rows]

    def node(self, group: str, uuid: str) -> Node | None:
        rows = self._read(
            group,
            "MATCH (n:Entity {uuid: $uuid}) RETURN n.uuid, labels(n), n.name, n.summary, n.provenance, "
            f"n.verification, n.created_at, 0, {_LOOP_MAP}",
            {"uuid": uuid},
        )
        return _node_of(rows[0]) if rows else None

    def delete_node(self, group: str, uuid: str) -> None:
        self._graph(group).query("MATCH (n:Entity {uuid: $uuid}) DETACH DELETE n", {"uuid": uuid})

    def episodes_of(self, group: str, uuid: str) -> list[tuple[str, str]]:
        rows = (
            self._graph(group)
            .query("MATCH (e:Episodic)-[:MENTIONS]->(n:Entity {uuid: $uuid}) RETURN e.uuid, e.name", {"uuid": uuid})
            .result_set
        )
        # La fuente es la sesión del episodio (session-<id>-<último mensaje>): varias partes de una
        # misma conversación no son fuentes independientes.
        return [(str(u), "-".join(str(n or "").split("-")[:2])) for u, n in rows]

    def delete_edge(self, group: str, edge: Edge) -> None:
        self._graph(group).query(
            "MATCH (a:Entity {uuid: $source})-[r:RELATES_TO {name: $name}]->(b:Entity {uuid: $target}) DELETE r",
            {"source": edge.source, "target": edge.target, "name": edge.name},
        )

    def edges_of(self, group: str, uuid: str) -> list[Edge]:
        rows = (
            self._graph(group)
            .query(
                "MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) WHERE a.uuid = $uuid OR b.uuid = $uuid "
                "RETURN a.uuid, b.uuid, r.name, r.fact, r.provenance, r.valid_at, r.invalid_at",
                {"uuid": uuid},
            )
            .result_set
        )
        return [_edge_of(row) for row in rows]

    def edges(self, group: str, limit: int) -> list[Edge]:
        rows = (
            self._graph(group)
            .query(
                "MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.uuid, b.uuid, r.name, r.fact, "
                "r.provenance, r.valid_at, r.invalid_at LIMIT $limit",
                {"limit": limit},
            )
            .result_set
        )
        return [_edge_of(row) for row in rows]

    def groups(self) -> list[str]:
        return sorted(g for g in self._db.list_graphs() if g.startswith("b_"))


# Lo que Graphiti extrae de una conversación no trae procedencia: es lo conversado.
DEFAULT_PROVENANCE = "conversation"

def _loop_map(var: str) -> str:
    return "{" + ", ".join(f"{key}: {var}.{key}" for key in LOOP_PROPS) + "}"


_LOOP_MAP = _loop_map("n")

# DDL de Graphiti 0.31.1 para `:Entity` (graph_queries.py:97-99) más `search_text` (MCB-009).
FULLTEXT_DDL = (
    "CREATE FULLTEXT INDEX FOR (n:Entity) ON (n.name, n.summary, n.group_id, n.search_text) "
    f"OPTIONS {{stopwords: {list(words.GRAPHITI_STOPWORDS)}}}"
)
FULLTEXT_ADD_FIELD = "CREATE FULLTEXT INDEX FOR (n:Entity) ON (n.search_text)"


def _already_indexed(error: Exception) -> bool:
    text = str(error).casefold()
    return "already" in text


def _node_of(row: Any) -> Node:
    uuid, labels, name, summary, provenance, verification, created_at, mentions, loop = row
    specific = [label for label in labels if label != "Entity"]
    return Node(
        uuid=str(uuid),
        type_name=specific[0] if specific else "Entity",
        name=str(name or ""),
        summary=str(summary or ""),
        provenance=str(provenance or DEFAULT_PROVENANCE),
        verification=str(verification or "OBSERVED"),
        created_at=str(created_at or ""),
        mentions=int(mentions or 0),
        attributes={key: value for key, value in (loop or {}).items() if value is not None},
    )


def _edge_of(row: Any) -> Edge:
    a, b, n, f, p, va, ia = row
    return Edge(
        source=str(a),
        target=str(b),
        name=str(n or "RELATES_TO"),
        fact=str(f or ""),
        provenance=str(p or DEFAULT_PROVENANCE),
        valid_at=str(va) if va else None,
        invalid_at=str(ia) if ia else None,
    )


SPANISH_RULE = (
    "Escribe siempre en español neutro (nombres, resúmenes, hechos y descripciones), aunque estas "
    "instrucciones estén en inglés. Conserva tal cual los nombres propios del negocio y sus productos."
)


def with_spanish(messages: list[Any]) -> list[Any]:
    """Agrega la regla de idioma al primer mensaje de sistema de cada llamada de Graphiti."""
    if messages and getattr(messages[0], "role", "") == "system" and SPANISH_RULE not in messages[0].content:
        first = messages[0].model_copy(update={"content": f"{messages[0].content}\n\n{SPANISH_RULE}"})
        return [first, *messages[1:]]
    return messages


_PRIMITIVE = (str, int, float, bool)
_SEED_ONLY = {"attributes_json"}


def _falkor_value(value: Any) -> Any:
    if value is None or isinstance(value, _PRIMITIVE):
        return value
    if isinstance(value, list) and all(item is None or isinstance(item, _PRIMITIVE) for item in value):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def falkor_safe_attributes(attributes: dict[str, Any] | None) -> dict[str, Any]:
    """Atributos que FalkorDB acepta: planos (sin el envoltorio `attributes` que a veces
    devuelve el modelo) y solo primitivos o listas de primitivos; lo demás va como JSON."""
    flat = dict(attributes or {})
    nested = flat.pop("attributes", None)
    if isinstance(nested, dict):
        for key, value in nested.items():
            flat.setdefault(key, value)
    return {key: _falkor_value(value) for key, value in flat.items() if key not in _SEED_ONLY}


def _install_falkor_adapter() -> None:
    """Graphiti 0.31.1 guarda los atributos tal cual en FalkorDB; aquí se dejan primitivos."""
    import graphiti_core.graphiti as graphiti_module

    original = getattr(graphiti_module, "add_nodes_and_edges_bulk")  # noqa: B009 - no exportado
    if getattr(original, "_saleads_safe", False):
        return

    async def safe(
        driver: Any, episodic_nodes: Any, episodic_edges: Any, entity_nodes: Any, entity_edges: Any, embedder: Any
    ) -> Any:
        # Graphiti la llama con argumentos por nombre: se conservan los nombres exactos.
        for item in [*entity_nodes, *entity_edges]:
            item.attributes = falkor_safe_attributes(item.attributes)
        return await original(
            driver=driver,
            episodic_nodes=episodic_nodes,
            episodic_edges=episodic_edges,
            entity_nodes=entity_nodes,
            entity_edges=entity_edges,
            embedder=embedder,
        )

    safe._saleads_safe = True  # type: ignore[attr-defined]
    setattr(graphiti_module, "add_nodes_and_edges_bulk", safe)  # noqa: B010 - no exportado


def graphiti_for(settings: Settings, http_client: Any) -> Any:
    """Graphiti con DeepSeek por OpenRouter en modo json_schema (compuerta OSB-001)."""
    from graphiti_core import Graphiti
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
    from openai import AsyncOpenAI

    if not settings.api_key:
        raise RuntimeError("llm_disabled")
    _install_falkor_adapter()
    client = AsyncOpenAI(api_key=settings.api_key, base_url=OPENROUTER_BASE, http_client=http_client)
    config = LLMConfig(
        api_key=settings.api_key,
        base_url=OPENROUTER_BASE,
        model=settings.llm_model,
        small_model=settings.llm_model,
    )

    class SpanishClient(OpenAIGenericClient):
        """Todas las llamadas (extracción, resúmenes, dedupe) escriben en español (laboratorio ronda 3)."""

        async def _generate_response(self, messages: list[Any], *args: Any, **kwargs: Any) -> dict[str, Any]:
            return await super()._generate_response(with_spanish(messages), *args, **kwargs)

    return Graphiti(
        graph_driver=FalkorDriver(host=settings.falkor_host, port=settings.falkor_port),
        llm_client=SpanishClient(config, client=client, max_tokens=8192, structured_output_mode="json_schema"),
        embedder=OpenAIEmbedder(
            OpenAIEmbedderConfig(
                api_key=settings.api_key,
                base_url=OPENROUTER_BASE,
                embedding_model=settings.embedding_model,
            ),
            client=client,
        ),
        cross_encoder=OpenAIRerankerClient(config=config, client=client),
        max_coroutines=6,
    )
