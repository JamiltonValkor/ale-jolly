"""Servidor del cerebro en la VM: MCP para el agente y HTTP interno para los jobs.

Solo escucha dentro de la red docker `hermes-net` (sin puertos publicados).
- MCP (streamable HTTP, /mcp): herramientas `brain_*` para Hermes.
- POST /run/<cmd>: lo llaman los scripts de los jobs sin agente.
- GET /health.
"""

from __future__ import annotations

import hmac
from datetime import UTC, datetime, timedelta
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse

from saleads_brain import search as words
from saleads_brain.app import COMMANDS, Brain
from saleads_brain.export_debounce import SnapshotDebouncer
from saleads_brain.facts import FactError, record_fact
from saleads_brain.graph import LOOP_PROPS, SEARCH_MODE, Node
from saleads_brain.loop import LoopError
from saleads_brain.provenance import Provenance
from saleads_brain.web import Web

ALE_HEADER = "x-saleads-brain-token"

INSTRUCTIONS = (
    "Business memory stores and retrieves; it does not reason for you. Query keywords before asserting facts "
    "(brain_query: approved budget, not a long question). Record actual owner statements with original words. "
    "For owner_decided supply owner_quote verbatim; missing or assistant-echo quotes remain unverified "
    "(see degradado). Track outstanding work with brain_loops_open/close and actual evidence. Read "
    "brain_value_report to reduce noise. Never invent business facts or attribute your deductions to the owner."
)


def _fact(node: Node) -> dict[str, Any]:
    """A brain_query fact with identity, provenance and loop attributes."""
    return {
        "fact": f"{node.type_name}: {node.name} — {node.summary}"[:300],
        "valid_at": None,
        "invalid_at": None,
        "uuid": node.uuid,
        "type": node.type_name,
        "provenance": node.provenance,
        "verification": node.verification,
        "created_at": node.created_at or None,
        **{key: node.attributes[key] for key in LOOP_PROPS if node.attributes.get(key) not in (None, "")},
    }


def create_server(brain: Brain, web: Web | None = None, export_delay: float = 30.0) -> FastMCP:
    web = web or Web()
    # AAB-013 (D27): cada escritura tipada aceptada programa una exportación; la ráfaga comparte una.
    exporter = SnapshotDebouncer(lambda: brain.run("export-snapshot"), delay=export_delay)
    host = f"saleads-brain:{brain.settings.port}"
    mcp = FastMCP(
        "saleads-brain",
        instructions=INSTRUCTIONS,
        host="0.0.0.0",
        port=brain.settings.port,
        stateless_http=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[host, f"localhost:{brain.settings.port}"],
        ),
    )

    loop = brain.loop_writer()

    def rejected(error: LoopError) -> dict[str, Any]:
        return {"accepted": False, "reason": str(error)}

    @mcp.tool()
    async def brain_query(business_id: str, query: str, limit: int = 8) -> dict[str, Any]:
        """Search business memory by keywords: owner statements/decisions, bets, verdicts, lessons and bootstrap.
        Use short keywords, with or without accents. Each fact includes uuid, type, provenance and date. If
        empty, vacio_por distinguishes no matches from no business data."""
        limit = max(1, min(limit, 20))
        try:
            group = loop.group(business_id)
        except LoopError as error:
            return {**rejected(error), "facts": []}
        # Sin grafo no se consulta nada: en FalkorDB una consulta a un grafo inexistente lo crea (F6).
        if group not in brain.store.groups():
            return {"facts": [], "modo": SEARCH_MODE, "vacio_por": "negocio_sin_datos"}
        nodes, mode = brain.store.search(group, words.terms(query), limit)
        nodes = [n for n in nodes
                 if n.type_name != "SpecialistExperience" and n.attributes.get("scope") != "specialist"]
        out: dict[str, Any] = {"facts": [_fact(n) for n in nodes], "modo": mode}
        if not nodes:
            out["vacio_por"] = "sin_coincidencias"
        return out

    @mcp.tool()
    async def brain_ingest(
        business_id: str,
        text: str,
        provenance: str = "owner_said",
        owner_quote: str | None = None,
        scope: list[str] | None = None,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        """Store what the owner said (owner_said) or decided (owner_decided), preserving their words. For
        owner_decided supply owner_quote as the literal owner phrase (at most 500 characters). Missing,
        unmatched or assistant-echo quotes remain unverified; degradado explains sin_cita, cita_no_encontrada,
        eco_de_ale or pendiente_de_verificar. Default scope is ["negocio"]."""
        if brain.settings.managed_curation_enabled:
            return {"accepted": False, "reason": "managed_source_required"}
        if provenance not in ("owner_said", "owner_decided") or not text.strip():
            return {"accepted": False}
        try:
            result = loop.record_owner_note(
                business_id=business_id, text=text, provenance=provenance, owner_quote=owner_quote, scope=scope,
                as_of=as_of,
            )
        except LoopError as error:
            return rejected(error)
        # El evento se conserva para la traza; `graph_uuid` le dice a backfill-owner-notes que ya está en el grafo.
        brain.ledger.record_event(
            business_id=business_id,
            kind="owner_message",
            provenance=Provenance(result["provenance"]),
            source_uri="mcp://brain_ingest",
            occurred_at=datetime.now(UTC).isoformat(),
            payload={"text": text[:2000], "graph_uuid": result["node_uuid"]},
        )
        return exported(result)

    def is_ale(ctx: Context) -> bool:  # type: ignore[type-arg]
        """Second layer after profile tool filters: only the Ale MCP client supplies its token."""
        expected = brain.settings.ale_token
        request = getattr(ctx.request_context, "request", None)
        got = request.headers.get(ALE_HEADER, "") if request is not None else ""
        return bool(expected) and hmac.compare_digest(got, expected or "")

    def exported(result: dict[str, Any]) -> dict[str, Any]:
        if result.get("accepted"):
            exporter.schedule()
        return result

    def guarded(write: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            result: dict[str, Any] = write(**kwargs)
            return result
        except LoopError as error:
            return {"accepted": False, "reason": str(error)}

    @mcp.tool()
    async def brain_record_bet(
        business_id: str,
        statement: str,
        avatar: str,
        angle: str,
        format: str,
        adset_ids: list[str] | None = None,
        round: int = 1,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        """Record a business bet: avatar, angle, format and actual Meta adset IDs. Identical avatar/angle/format
        text reuses its node. round identifies the loop round; do not invent commercial execution."""
        return exported(guarded(
            loop.record_bet,
            business_id=business_id,
            statement=statement,
            avatar=avatar,
            angle=angle,
            format=format,
            adset_ids=adset_ids,
            round=round,
            as_of=as_of,
        ))

    @mcp.tool()
    async def brain_link_bet(business_id: str, bet_uuid: str, saleads_bet_id: str) -> dict[str, Any]:
        """Link an existing memory bet_uuid to its SaleADS bet_id returned by apuestas registrar. An existing
        link to a different bet_id is not overwritten: apuesta_ya_unida."""
        return exported(guarded(
            loop.link_bet, business_id=business_id, bet_uuid=bet_uuid, saleads_bet_id=saleads_bet_id
        ))

    @mcp.tool()
    async def brain_attach_adset(
        business_id: str, bet_uuid: str, adset_id: str, as_of: str | None = None
    ) -> dict[str, Any]:
        """Attach an actual published Meta adset ID to its existing bet."""
        return guarded(loop.attach_adset, business_id=business_id, bet_uuid=bet_uuid, adset_id=adset_id, as_of=as_of)

    @mcp.tool()
    async def brain_record_result(
        business_id: str, adset_id: str, spend: float, purchases: float = 0, leads: float = 0, as_of: str | None = None
    ) -> dict[str, Any]:
        """Store an actual cumulative SaleADS adset reading and observation date. Return the difference since the
        previous reading: spend, purchases, leads and CPA. The adset must already be linked to a bet."""
        return guarded(
            loop.record_result,
            business_id=business_id,
            adset_id=adset_id,
            spend=spend,
            purchases=purchases,
            leads=leads,
            as_of=as_of,
        )

    @mcp.tool()
    async def brain_record_verdict(
        business_id: str,
        bet_uuid: str,
        outcome: str,
        reason: str,
        result_uuids: list[str],
        min_spend: float,
        lead_quality: str = "",
        as_of: str | None = None,
    ) -> dict[str, Any]:
        """Record an operational verdict using stable status values gana, sigue, espera, pierde or sin_datos.
        Cite actual adset readings; gana/pierde require minimum window spend. Describe a win in this test,
        never a universal cause."""
        return exported(guarded(
            loop.record_verdict,
            business_id=business_id,
            bet_uuid=bet_uuid,
            outcome=outcome,
            reason=reason,
            result_uuids=result_uuids,
            min_spend=min_spend,
            lead_quality=lead_quality,
            as_of=as_of,
        ))

    @mcp.tool()
    async def brain_record_learning(
        business_id: str,
        statement: str,
        anchor_uuid: str,
        confidence: str,
        evidence: str,
        ctx: Context,  # type: ignore[type-arg]
        replaces_uuid: str | None = None,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        """Only Ale. Store a business lesson anchored to a real verdict or owner decision with confidence baja,
        media or alta and evidence. Use replaces_uuid for a contradiction: retain replaced history with date.
        Repeated identical text adds evidence."""
        if not is_ale(ctx):
            return {"accepted": False, "reason": "profile_not_allowed"}
        return exported(guarded(
            loop.record_learning,
            business_id=business_id,
            statement=statement,
            anchor_uuid=anchor_uuid,
            confidence=confidence,
            evidence=evidence,
            replaces_uuid=replaces_uuid,
            as_of=as_of,
        ))

    @mcp.tool()
    async def brain_record_feedback(
        business_id: str,
        text: str,
        scope: list[str],
        ctx: Context,  # type: ignore[type-arg]
        about_uuid: str | None = None,
        as_of: str | None = None,
        owner_quote: str | None = None,
    ) -> dict[str, Any]:
        """Only Ale. Store an owner correction/preference with explicit scope, for example ["avatar:mamas"],
        ["campaña:123"] or ["negocio"]. Empty scope is rejected, not global. owner_quote must be the literal
        owner phrase (at most 500 characters); it becomes the summary and your text remains interpretation.
        Missing, unmatched or assistant-echo quotes are inferred and marked degradado."""
        if not is_ale(ctx):
            return {"accepted": False, "reason": "profile_not_allowed"}
        return exported(guarded(
            loop.record_decision, business_id=business_id, text=text, scope=scope, about_uuid=about_uuid, as_of=as_of,
            owner_quote=owner_quote,
        ))

    @mcp.tool()
    async def brain_record_fact(
        business_id: str,
        path: str,
        value: str | list[str],
        provenance: str,
        evidence: str,
        ctx: Context,  # type: ignore[type-arg]
        offering_ref: str | None = None,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        """Only Ale. Record a declared/corrected business field alongside feedback using the exact closed BI
        path, for example audiencia.ideal_client or voz.voice_tones. Preserve provenance owner_said,
        owner_decided or agent_inferred; deductions never overwrite owner statements. evidence is the
        supporting phrase/fact without personal data. offering_ref UUID is only for offering.* paths."""
        if not is_ale(ctx):
            return {"accepted": False, "reason": "profile_not_allowed"}
        try:
            return exported(record_fact(
                brain.ledger, business_id=business_id, path=path, value=value, provenance=provenance, evidence=evidence,
                observed_at=as_of or datetime.now(UTC).isoformat(), offering_ref=offering_ref,
                keep_names=brain._business_names(business_id),
            ))
        except FactError as error:
            return {"accepted": False, "reason": str(error)}
        except ValueError:
            return {"accepted": False, "reason": "as_of_invalid"}

    @mcp.tool()
    async def brain_snapshot_flush(ctx: Context) -> dict[str, Any]:  # type: ignore[type-arg]
        """Only Ale. Export the current business-memory snapshot at round closure, including when the response is
        [SILENT]. Return written and business/node counts."""
        if not is_ale(ctx):
            return {"accepted": False, "reason": "profile_not_allowed"}
        result = await exporter.flush()
        return {
            "written": bool(result.get("written")),
            "businesses": result.get("businesses", 0),
            "nodes": result.get("nodes", 0),
        }

    @mcp.tool()
    async def brain_propose_type(
        business_id: str,
        name: str,
        definition: str,
        evidence_refs: list[str],
        extends: str | None = None,
    ) -> dict[str, Any]:
        """Propose a type extending a base type, supported by at least two distinct sources."""
        schema: dict[str, Any] = {"extends": extends} if extends else {}
        try:
            proposal_id = brain.ledger.propose_ontology_change(
                business_id=business_id,
                proposal_kind="entity_type",
                name=name,
                definition=definition,
                schema=schema,
                evidence_refs=evidence_refs,
                proposer_id="hermes",
            )
        except ValueError as error:
            return {"accepted": False, "reason": str(error)}
        return {"accepted": True, "proposal_id": proposal_id}

    @mcp.tool()
    async def brain_loops_open(business_id: str, title: str, kind: str = "finding") -> dict[str, Any]:
        """Open an outstanding item that must later be closed with evidence."""
        try:
            loop.group(business_id)
        except LoopError as error:
            return rejected(error)
        return {"loop_id": brain.ledger.open_loop(business_id=business_id, title=title[:200], kind=kind[:40])}

    @mcp.tool()
    async def brain_loops_close(loop_id: str, evidence: str) -> dict[str, Any]:
        """Close an outstanding item using freshly read resolution evidence, not an assumption."""
        try:
            return {"closed": brain.ledger.close_loop(loop_id, evidence[:1000])}
        except ValueError as error:
            return {"closed": False, "reason": str(error)}

    @mcp.tool()
    async def brain_loops(business_id: str | None = None) -> dict[str, Any]:
        """Read open loops, all owned businesses or one explicit business."""
        return {"loops": brain.ledger.loops(business_id)}

    @mcp.tool()
    async def brain_value_report(business_id: str, days: int = 30) -> dict[str, Any]:
        """Read value/noise measures: AI cost, assistant messages versus owner replies and closed loops."""
        try:
            loop.group(business_id)
        except LoopError as error:
            return rejected(error)
        since = (datetime.now(UTC) - timedelta(days=max(1, min(days, 365)))).date().isoformat()
        return brain.ledger.value_report(business_id, since)

    @mcp.tool()
    async def brain_decide(business_id: str, kind: str, situation: str) -> dict[str, Any]:
        """Disabled compatibility tool. Always returns sin_senal; use evidence and your own judgment."""
        del business_id, kind, situation  # Jev apagado (MCB-009, D16): sin red, sin key y sin registrar nada
        return {"senal": "sin_senal", "motivo": "jev_apagado"}

    @mcp.tool()
    async def web_buscar(
        business_id: str, query: str, idioma: str = "es", pais: str = "CO", desde: str | None = None
    ) -> dict[str, Any]:
        """Legacy internet research through Google News RSS and Bing RSS. Return title, URL, source,
        publication/observation dates and source status/reason. desde is an ISO date. Never use it for private
        business data. This legacy tool is excluded from managed Meta research, which uses saleads_web_search."""
        del business_id  # sin uso por ahora: la búsqueda no cambia por negocio
        return await web.buscar(query, idioma=idioma, pais=pais, desde=desde)

    @mcp.tool()
    async def web_leer(url: str) -> dict[str, Any]:
        """Legacy public HTTP/HTTPS page reader, respecting robots.txt. Return explicit state/reason on failure;
        truncado marks incomplete text. Excluded from managed Meta research, which uses only
        saleads_web_search."""
        return await web.leer(url)

    @mcp.tool()
    async def brain_lessons_pending(limit: int = 10) -> dict[str, Any]:
        """Read de-identified lessons eligible for saleads_share_learning; never personal or platform data."""
        return {"lessons": brain.ledger.lessons("pending", limit)}

    @mcp.tool()
    async def brain_lesson_mark(lesson_id: str, status: str) -> dict[str, Any]:
        """Mark an eligible lesson shared, rejected by the inbox, or discarded."""
        try:
            return {"updated": brain.ledger.mark_lesson(lesson_id, status)}
        except ValueError as error:
            return {"updated": False, "reason": str(error)}

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @mcp.custom_route("/run/{command}", methods=["POST"])
    async def run(request: Request) -> JSONResponse:
        command = request.path_params["command"]
        if command not in COMMANDS:
            return JSONResponse({"ok": False, "message": ""}, status_code=404)
        try:
            return JSONResponse(await brain.run(command))
        except Exception as error:  # noqa: BLE001 - el job no debe filtrar detalles; queda el tipo
            return JSONResponse({"ok": False, "message": "", "error": type(error).__name__}, status_code=500)

    from saleads_brain.continuous_server import install_continuous_routes

    install_continuous_routes(mcp, brain, exporter)
    return mcp
