"""ingest-seed: lo que SaleADS ya sabe del negocio entra como hechos, sin IA (invariante 3).

La semilla (`saleads-seed/1`) trae, por negocio, la salida de la tool del MCP
`saleads_get_business_bootstrap` (/1 o /2, ya sin datos personales). Desde la
ola del loop de marketing (MLB-010) ya no vuelca el catálogo: arma el estado
inicial del loop.

- Negocio, sus productos y servicios (SELLS) y las ofertas que usa una apuesta
  (o las 5 principales si no hay plan).
- Por cada campaña del plan, una apuesta (Bet) con su avatar y su ángulo, sacados
  de la tesis de persuasión (/2) o del resumen de comunicación.
- Las campañas lanzadas con sus cajas (AdSet, id de Meta) y la lectura de cada
  caja (Result) cuando el bootstrap la trae.
- La lista de lo que falta, para que Ale lo pregunte.

Toda arista usa un par declarado en la ontología. Re-sembrar no duplica y
retira lo que sembró la v1 (tipos viejos, «Precio de X», aristas sin par), sin
tocar lo que salió de una conversación. Los avatares, ángulos y cajas usan los
mismos ids que las escrituras del loop, así una apuesta posterior los reutiliza.
"""

from __future__ import annotations

import html
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from saleads_brain.graph import Edge, GraphStore, Node
from saleads_brain.ledger import Ledger, stable_id
from saleads_brain.loop import _norm, _uuid, short_name
from saleads_brain.ontology import base
from saleads_brain.privacy import redact
from saleads_brain.provenance import Provenance
from saleads_brain.settings import group_id

MAX_PER_KIND = 50
TOP_OFFERS = 5
SEED = "saleads_seed"
BOOTSTRAP_SCHEMAS = ("saleads-business-bootstrap/1", "saleads-business-bootstrap/2")
# Lo que sembró la v1 y ya no se siembra (MLB-010): se retira al re-sembrar.
V1_TYPES = frozenset({"Hypothesis", "MetricObservation", "Creative"})
V1_EDGE = "RELATES_TO"


def _text(value: Any, limit: int = 300) -> str:
    """Texto de la semilla legible (sin entidades HTML del catálogo) y sin datos personales."""
    return redact(html.unescape(value).strip())[:limit] if isinstance(value, str) else ""


def _id(value: Any, limit: int = 64) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _money(amount: Any, currency: str) -> str:
    """`1200000` + `COP` → `1.200.000 COP` (como lo escribe un dueño en español)."""
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return f"{amount} {currency}".strip()
    whole = f"{value:,.0f}" if value == int(value) else f"{value:,.2f}"
    return f"{whole.replace(',', '.')} {currency}".strip()


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value[:MAX_PER_KIND] if isinstance(value, list) else []


def _num(value: Any) -> float | None:
    try:
        return float(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def declared_pair(name: str, source_type: str, target_type: str) -> bool:
    pairs = base().edges.get(name, ())
    return any(s in (source_type, "Entity") and t in (target_type, "Entity") for s, t in pairs)


class SeedLoader:
    def __init__(self, store: GraphStore, ledger: Ledger) -> None:
        self.store = store
        self.ledger = ledger

    def load_file(self, path: Path) -> dict[str, Any]:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("schema") != "saleads-seed/1":
            raise ValueError("seed_schema_invalid")
        totals: dict[str, Any] = {"businesses": 0, "nodes": 0, "edges": 0, "retired": 0}
        for business in _list(data.get("businesses")):
            counts = self.load_business(_record(business))
            totals["businesses"] += 1
            for key in ("nodes", "edges", "retired"):
                totals[key] += counts[key]
        return totals

    def load_business(self, payload: dict[str, Any]) -> dict[str, Any]:
        business_id = _id(payload.get("business_id"), 64)
        if not business_id:
            raise ValueError("seed_business_without_id")
        version = payload.get("schema_version") or "saleads-business-bootstrap/1"
        if version not in BOOTSTRAP_SCHEMAS:
            raise ValueError("seed_bootstrap_schema_invalid")
        group = group_id(business_id)
        when = _text(payload.get("generated_at"), 40) or datetime.now(UTC).isoformat()
        counter: dict[str, Any] = {"nodes": 0, "edges": 0, "retired": self.retire_v1(group), "missing": []}
        types: dict[str, str] = {}

        def put(
            uuid: str, type_name: str, name: str, summary: str = "", verification: str = "SYSTEM_VERIFIED", **attrs: Any
        ) -> str:
            self.store.upsert_node(
                group,
                Node(
                    uuid=uuid,
                    type_name=type_name,
                    name=name[:200] or type_name,
                    summary=summary,
                    provenance=SEED,
                    verification=verification,
                    created_at=when,
                    attributes={k: v for k, v in attrs.items() if v not in (None, "")},
                ),
            )
            types[uuid] = type_name
            counter["nodes"] += 1
            return uuid

        def node(type_name: str, key: str, name: str, summary: str = "", **attrs: Any) -> str:
            return put(stable_id(group, type_name, key), type_name, name, summary, **attrs)

        def concept(type_name: str, label: str, **attrs: Any) -> str:
            """Avatar y ángulo: mismo id que las escrituras del loop (brain_record_bet)."""
            return put(
                _uuid(group, type_name, _norm(label)),
                type_name,
                short_name(type_name, label),
                label[:500],
                verification="SELF_REPORTED",
                stage="en_plan",
                valid_from=when,
                **attrs,
            )

        def edge(source: str, target: str, name: str, fact: str = "") -> None:
            if not declared_pair(name, types.get(source, ""), types.get(target, "")):
                raise ValueError(f"seed_edge_not_declared:{name}:{types.get(source)}->{types.get(target)}")
            self.store.upsert_edge(group, Edge(source=source, target=target, name=name, fact=fact, valid_at=when))
            counter["edges"] += 1

        context = _record(payload.get("context"))
        facts = _record(context.get("facts"))
        biz = _record(facts.get("business"))
        brand = _record(facts.get("brand"))
        business = node(
            "Business",
            business_id,
            _text(biz.get("name")) or "Negocio",
            _text(biz.get("description"), 500),
            industry_code=_text(biz.get("industry"), 80),
            website=_text(biz.get("website"), 200),
            voice_notes=_text(brand.get("tone"), 200),
        )

        # Productos y servicios (todos, son el catálogo del negocio); ofertas solo las que se usan.
        products: list[tuple[str, dict[str, Any]]] = []
        for kind, items in (("product", facts.get("products")), ("service", facts.get("services"))):
            for item in _list(items):
                row = _record(item)
                name = _text(row.get("name"), 120)
                if not name:
                    continue
                key = _id(row.get("id"), 64) or _id(row.get("name"), 120)
                uuid = node(
                    "ProductOrService",
                    key,
                    name,
                    _text(row.get("description"), 400),
                    offering_kind=kind,
                    category=_text(row.get("category"), 80),
                )
                edge(business, uuid, "SELLS")
                products.append((key, {**row, "_uuid": uuid, "_name": name}))

        # Audiencia declarada y sus necesidades.
        audience = _record(facts.get("audience"))
        segment = None
        if _text(audience.get("description")):
            segment = node(
                "Segment", "audience", _text(audience.get("description"), 120), _text(audience.get("description"), 400)
            )
        buyer_fit = _record(context.get("buyer_fit"))
        for field in ("pain_points", "jobs_to_be_done", "objections", "desired_outcomes"):
            for need in _list(_record(buyer_fit.get(field)).get("value"))[:10]:
                if isinstance(need, str) and need.strip():
                    if segment is None:
                        segment = node(
                            "Segment", "audience", "Clientes del negocio", "Audiencia sin describir en SaleADS"
                        )
                    text = redact(need)
                    need_id = node("CustomerNeed", f"{field}:{text}", text[:120], text[:400], trigger=field)
                    edge(segment, need_id, "HAS_NEED", field)

        # Apuestas del plan: avatar y ángulo desde la tesis (/2) o desde el resumen de comunicación.
        plan = _record(payload.get("plan"))
        used_products: set[str] = set()
        bets = 0
        for item in _list(plan.get("campaigns")):
            row = _record(item)
            thesis = _record(row.get("persuasion_thesis"))
            summary = _record(row.get("communication_summary"))
            avatar = _text(thesis.get("avatar"), 200) or _text(summary.get("audience"), 200)
            angle_rec = _record(thesis.get("angle"))
            angle = _text(angle_rec.get("rationale"), 200) or _text(summary.get("tension"), 200)
            statement = (
                _text(thesis.get("promise"), 300) or _text(summary.get("promise"), 300) or _text(row.get("name"), 120)
            )
            if not (avatar and angle and statement):
                counter["missing"].append(f"apuesta_sin_avatar_o_angulo:{_text(row.get('name'), 80) or 'campaña'}")
                continue
            launched = _text(row.get("status"), 40) in ("launched", "active", "running")
            bet = node(
                "Bet",
                f"plan:{_id(row.get('item_id'))}",
                short_name("Apuesta del plan", statement),
                statement,
                stage="lanzada" if launched else "en_plan",
                round=1,
                valid_from=when,
                bet_status=_text(row.get("status"), 40),
            )
            avatar_id = concept(
                "Avatar", avatar, pain=_text(thesis.get("pain"), 200), desire=_text(thesis.get("desire"), 200)
            )
            angle_id = concept("Angle", angle, awareness_stage=_text(thesis.get("awareness_stage"), 40))
            edge(bet, avatar_id, "TARGETS", f"Le habla a {avatar[:120]}")
            edge(bet, angle_id, "USES", f"Usa el ángulo {angle[:120]}")
            edge(angle_id, avatar_id, "SPEAKS_WITH", f"{angle[:80]} → {avatar[:80]}")
            offering = _id(row.get("offering_id"), 64)
            if offering:
                used_products.add(offering)
            bets += 1

        # Ofertas: las que usa una apuesta; si no se sabe cuáles (o no hay plan), las 5 principales.
        offered = [p for p in products if p[0] in used_products] if used_products else products[:TOP_OFFERS]
        for key, row in offered:
            if row.get("price") is None:
                continue
            currency = _text(row.get("currency"), 8)
            offer = node(
                "Offer",
                f"offer:{key}",
                f"Oferta: {row['_name']}"[:120],
                _money(row.get("price"), currency),
                price=str(row.get("price")),
                currency=currency,
            )
            edge(row["_uuid"], offer, "OFFERED_AS", "Precio registrado en SaleADS")

        # Campañas lanzadas, sus cajas y la lectura de cada caja.
        for item in _list(payload.get("campaigns")):
            row = _record(item)
            campaign_id = _id(row.get("campaign_id"), 64)
            if not campaign_id:
                continue
            campaign = node(
                "Campaign",
                f"campaign:{campaign_id}",
                _text(row.get("name"), 120) or "Campaña",
                status=_text(row.get("status"), 40),
                platform_ids=campaign_id,
            )
            for box in _list(row.get("boxes")):
                entity = _record(box)
                meta_id = _id(entity.get("meta_ad_id") or entity.get("entity_id"), 64)
                if entity.get("entity_type") != "ad_set" or not meta_id:
                    continue
                adset = put(
                    _uuid(group, "AdSet", meta_id),
                    "AdSet",
                    short_name("Caja", meta_id),
                    canonical_id=meta_id,
                    valid_from=when,
                )
                edge(campaign, adset, "CONTAINS", "Caja de la campaña lanzada")
                metrics = _record(entity.get("metrics"))
                spend, purchases, leads = (
                    _num(metrics.get("spend")),
                    _num(metrics.get("purchases")),
                    _num(metrics.get("leads")),
                )
                if spend is None:
                    continue
                result = put(
                    _uuid(group, "Result", adset, when),
                    "Result",
                    short_name("Lectura", f"{meta_id} {when[:10]}"),
                    f"Acumulado de la semilla: gasto {spend}, compras {purchases or 0}, leads {leads or 0}.",
                    read_at=when,
                    spend=spend,
                    purchases=purchases or 0.0,
                    leads=leads or 0.0,
                    cpa=round(spend / purchases, 2) if purchases else 0.0,
                    window_days=0,
                )
                edge(adset, result, "GIVES", "Lectura acumulada (semilla)")

        if not plan:
            counter["missing"].append("plan_estrategico")
        if not products:
            counter["missing"].append("productos_o_servicios")
        counter["missing"].extend(f"bi:{u}" for u in _list(context.get("unknowns"))[:20] if isinstance(u, str))
        counter["missing"].extend(f"seed:{w}" for w in _list(payload.get("warnings")) if isinstance(w, str))
        self.store.repair_edges(group)
        self.ledger.record_event(
            business_id=business_id,
            kind="business_profile",
            provenance=Provenance.SALEADS_SEED,
            source_uri="seed://bootstrap",
            occurred_at=when if "T" in when else "2026-11-01T18:18:45+00:00",
            payload={
                "nodes": counter["nodes"],
                "edges": counter["edges"],
                "bets": bets,
                "missing": counter["missing"][:40],
            },
        )
        return counter

    def retire_v1(self, group: str) -> int:
        """Retira lo sembrado por la v1 que no conecta con el loop. Nunca toca nodos de conversación."""
        # Un negocio nuevo no tiene legado; GRAPH.RO_QUERY no debe crear su grafo.
        if group not in self.store.groups():
            return 0
        retired = 0
        for node in self.store.nodes(group, 2000):
            if node.provenance != SEED:
                continue
            stale = node.type_name in V1_TYPES or (node.type_name == "Offer" and node.name.startswith("Precio de "))
            if not stale:
                continue
            loop_edges = [e for e in self.store.edges_of(group, node.uuid) if e.provenance != SEED]
            if loop_edges:
                continue
            self.store.delete_node(group, node.uuid)
            retired += 1
        for edge in self.store.edges(group, 5000):
            if edge.name == V1_EDGE and edge.provenance == SEED:
                self.store.delete_edge(group, edge)
        return retired
