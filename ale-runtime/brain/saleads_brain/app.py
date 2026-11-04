"""Ejecuta los comandos del cerebro (CLI y HTTP interno /run/<cmd>).

Cada comando devuelve `{"ok": bool, "message": str, ...}`. `message` vacío =
silencio: el script del job no imprime nada y Hermes no entrega nada.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from saleads_brain import analyze as analyze_mod
from saleads_brain import decay as decay_mod
from saleads_brain import snapshot
from saleads_brain.day import Episode, businesses_from_seed, ingest_day
from saleads_brain.graph import GraphStore
from saleads_brain.ledger import Ledger
from saleads_brain.lessons import SCHEMA, extract_lessons
from saleads_brain.loop import LoopWriter, backfill_owner_notes
from saleads_brain.ontology import ontology_for_event
from saleads_brain.privacy import redact, redact_people
from saleads_brain.quotes import checker_for
from saleads_brain.seed import SeedLoader
from saleads_brain.settings import OPENROUTER_BASE, Settings, group_id
from saleads_brain.usage import UsageMeter, current_business

# Reglas que se le dan a la extracción de Graphiti (laboratorio capa 1, L1-07/L1-13):
# su prompt base está en inglés y sin estas reglas mezcla idiomas, convierte a los
# hablantes en entidades y guarda a terceros con nombre y contacto.
EXTRACTION_RULES = (
    "Escribe nombres, resúmenes y hechos en español, como los diría el dueño del negocio. "
    "La conversación es entre el Dueño del negocio y su Asistente: no crees entidades para «Dueño», "
    "«Asistente», «Usuario» ni para el chat; lo que dicen se atribuye al negocio. "
    "No guardes personas con nombre propio que no sean el negocio (clientas, clientes, empleados, "
    "socios, repartidores): descríbelas por su rol, sin nombre propio, y nunca guardes teléfonos, "
    "correos ni direcciones. "
    "Los nombres de relación son cortos, en MAYÚSCULAS_CON_GUIONES_BAJOS (por ejemplo VENDE, CUESTA, "
    "DIRIGIDO_A). Un precio que el dueño corrige reemplaza al anterior."
)

# Eventos cuya ontología usa la extracción libre de lo conversado (sin los tipos del núcleo del loop).
EXTRACTION_EVENTS = ("business_profile", "market", "campaign", "strategy", "decision", "loop")

COMMANDS = (
    "ingest-seed",
    "ingest-day",
    "analyze",
    "export-snapshot",
    "extract-lessons",
    "decay",
    "backfill-owner-notes",
)


class Brain:
    def __init__(self, settings: Settings, store: GraphStore, ledger: Ledger, meter: UsageMeter | None = None) -> None:
        self.settings = settings
        self.store = store
        self.ledger = ledger
        self.meter = meter or UsageMeter()
        self._graphiti: Any = None

    def loop_writer(self) -> LoopWriter:
        """Escrituras tipadas con los negocios de la semilla y la cita del dueño verificada en `state.db`."""
        return LoopWriter(
            self.store,
            self.ledger,
            known_businesses=lambda: {b.business_id.lower() for b in businesses_from_seed(self.settings.seed_path)},
            quote_checker=checker_for(self.settings.state_db),
        )

    def graphiti(self) -> Any:
        if self._graphiti is None:
            from saleads_brain.graph import graphiti_for

            self._graphiti = graphiti_for(self.settings, self.meter.client())
        return self._graphiti

    async def run(self, command: str, arg: str | None = None) -> dict[str, Any]:
        if command not in COMMANDS:
            raise ValueError("unknown_command")
        try:
            result = await getattr(self, command.replace("-", "_"))(arg)
        finally:
            self._flush_usage()
        return {"ok": True, "message": "", **result}

    async def ingest_seed(self, arg: str | None) -> dict[str, Any]:
        result = SeedLoader(self.store, self.ledger).load_file(Path(arg) if arg else self.settings.seed_path)
        if self.settings.llm_enabled:
            result = {**result, **(await self.embed_seed())}
        return result

    async def embed_seed(self) -> dict[str, Any]:
        """Embeddings de nombres y hechos sembrados: sin ellos Graphiti no encuentra el nodo de la
        semilla y lo duplica (laboratorio L1-03: «paquete de novia» vs «Paquete de novia completo»)."""
        missing = getattr(self.store, "missing_embeddings", None)
        if missing is None:
            return {"embedded": 0}
        embedder = self.graphiti().embedder
        done = 0
        for group in self.store.groups():
            nodes, edges = missing(group)
            for kind, items in (("node", nodes), ("edge", edges)):
                if not items:
                    continue
                vectors = await embedder.create_batch([text for _uuid, text in items])
                for (uuid, _text), vector in zip(items, vectors, strict=True):
                    self.store.set_embedding(group, kind, uuid, vector)  # type: ignore[attr-defined]
                    done += 1
        return {"embedded": done}

    async def backfill_owner_notes(self, _arg: str | None) -> dict[str, Any]:
        """MCB-009: lo que brain_ingest guardó solo en `events` antes de esta versión pasa al grafo (idempotente)."""
        if self.settings.managed_curation_enabled:
            return {"owner_notes": {"created": 0, "skipped": 0, "rejected": 0}, "managed_sources": True}
        return {"owner_notes": backfill_owner_notes(self.loop_writer(), self.ledger)}

    async def ingest_day(self, _arg: str | None) -> dict[str, Any]:
        if self.settings.managed_curation_enabled:
            # Managed collectors have explicit native bindings. Never fall back
            # to mention-based routing or the first seeded business.
            return {"episodes": 0, "pending": 0, "managed_sources": True}
        # Va dentro de ingest-day para no depender de que el watcher agregue un job (MCB-009, MCB-011).
        notes = await self.backfill_owner_notes(None)
        add = self._add_batch if self.settings.llm_enabled else None
        if self.settings.llm_enabled:
            # Lo que escribió el loop (apuestas, avatares…) entra sin embedding: sin él la extracción
            # del día no lo encuentra y crea un duplicado (E2E simulado, «Mujeres post-parto» ×2).
            await self.embed_seed()
        result = await ingest_day(
            ledger=self.ledger,
            state_db=self.settings.state_db,
            seed_path=self.settings.seed_path,
            add_batch=add,
        )
        return {**result, **notes}

    async def analyze(self, _arg: str | None) -> dict[str, Any]:
        return analyze_mod.analyze(self.store, self.ledger, self.settings.learned_dir)

    async def decay(self, arg: str | None) -> dict[str, Any]:
        return decay_mod.decay(self.store, arg)

    async def export_snapshot(self, _arg: str | None) -> dict[str, Any]:
        return snapshot.write(self.store, self.settings.snapshot_path, self.ledger)

    async def extract_lessons(self, _arg: str | None) -> dict[str, Any]:
        if self.settings.managed_curation_enabled:
            return {"lessons": 0, "managed_sources": True}
        complete = self._complete if self.settings.llm_enabled else None
        return await extract_lessons(ledger=self.ledger, complete=complete, banned_names=self._banned_names())

    def _business_names(self, business_id: str) -> list[str]:
        """Nombre del negocio, productos y servicios: nunca se enmascaran como personas."""
        for business in businesses_from_seed(self.settings.seed_path):
            if business.business_id == business_id:
                return business.names
        return []

    async def _add_batch(self, business_id: str, episodes: list[Episode]) -> None:
        from graphiti_core.nodes import EpisodeType
        from graphiti_core.utils.bulk_utils import RawEpisode

        entities: dict[str, Any] = {}
        edges: dict[str, Any] = {}
        for kind in EXTRACTION_EVENTS:
            e, r = ontology_for_event(kind, self.settings.learned_dir / f"{business_id}.json")
            entities.update(e)
            edges.update(r)
        # Nombre único por tramo: el chat del dueño es una sesión larga que sigue cada día.
        names = [f"session-{e.session_id}-{e.last_message_id}" for e in episodes]
        self.store.forget_episodes(group_id(business_id), names)
        token = current_business.set(business_id)
        try:
            await self.graphiti().add_episode_bulk(
                [
                    RawEpisode(
                        name=name,
                        content=redact_people(redact(e.text), keep=self._business_names(business_id)),
                        source=EpisodeType.message,
                        source_description="conversación con el dueño",
                        reference_time=datetime.fromtimestamp(e.started_at, UTC),
                    )
                    for e, name in zip(episodes, names, strict=True)
                ],
                group_id=group_id(business_id),
                entity_types=entities,
                edge_types=edges,
                custom_extraction_instructions=EXTRACTION_RULES,
            )
        finally:
            current_business.reset(token)

    async def _complete(self, system: str, user: str) -> str:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self.settings.api_key, base_url=OPENROUTER_BASE, http_client=self.meter.client())
        response = await client.chat.completions.create(
            model=self.settings.llm_model,
            temperature=0,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "lessons", "schema": SCHEMA},
            },
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
        return response.choices[0].message.content or "{}"

    def _banned_names(self) -> dict[str, list[str]]:
        names: dict[str, list[str]] = {
            b.business_id: list(b.names) for b in businesses_from_seed(self.settings.seed_path)
        }
        if self.settings.seed_path.exists():
            data = json.loads(self.settings.seed_path.read_text(encoding="utf-8"))
            for item in data.get("businesses", []):
                facts = (item.get("context") or {}).get("facts") or {}
                for row in [*(facts.get("products") or []), *(facts.get("services") or [])]:
                    if isinstance(row, dict) and isinstance(row.get("name"), str):
                        names.setdefault(str(item.get("business_id")), []).append(row["name"])
        return names

    def _flush_usage(self) -> None:
        day = datetime.now(UTC).date().isoformat()
        for business_id, total in self.meter.drain().items():
            self.ledger.add_usage(day, business_id, total["tokens"], total["cost_usd"], int(total["calls"]))
