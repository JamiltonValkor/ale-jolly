"""Escrituras tipadas del loop de marketing (MLB-009).

Deterministas, sin IA: cada escritura se conecta a su ancla o se rechaza con un
motivo claro, para que el cerebro no acumule nodos sueltos (invariante 5):

- apuesta (Bet) → su avatar, su ángulo y su formato; opcionalmente sus cajas;
- resultado (Result) → una caja (AdSet, `canonical_id` = id de Meta) probada por una apuesta;
- veredicto (Verdict) → una apuesta y los resultados de sus cajas, con el gasto mínimo;
- aprendizaje (Learning) → un veredicto o una decisión del dueño; lo contradicho
  se reemplaza con fecha (SUPERSEDES), nunca se borra, y lo repetido suma evidencia;
- decisión del dueño (Decision) → con `scope` explícito; solo queda validada con la cita literal del
  dueño encontrada en `state.db` y sin eco de Ale (MCB-009). Sin cita, se guarda degradada;
- lo que el dueño dijo (OwnerNote) → con sus palabras; lo repetido suma evidencia (MCB-009).

Los nombres los arma el código (≤ 80 caracteres); la frase va en `summary`.
Todas aceptan `as_of` para que el simulador y el decaimiento usen fechas propias.
"""

from __future__ import annotations

import json
import re
import uuid as uuidlib
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from saleads_brain import quotes
from saleads_brain.graph import Edge, GraphStore, Node
from saleads_brain.ledger import Ledger, stable_id
from saleads_brain.provenance import Provenance
from saleads_brain.settings import group_id
from saleads_brain.states import VerificationState

MAX_NAME = 80
OUTCOMES = ("gana", "sigue", "espera", "pierde", "sin_datos")
CONFIDENCE = ("baja", "media", "alta")
OUTCOME_TEXT = {
    "gana": "ganó en esta prueba",
    "pierde": "perdió en esta prueba",
    "sigue": "sigue en prueba",
    "espera": "espera más datos",
    "sin_datos": "sin datos suficientes",
}


class LoopError(ValueError):
    """Escritura rechazada: el motivo es un código corto que el agente puede leer."""


def _as_of(value: str | None) -> str:
    if not value:
        return datetime.now(UTC).isoformat()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise LoopError("as_of_invalido") from error
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC).isoformat()


def short_name(prefix: str, text: str) -> str:
    """Nombre corto generado por código: «<Tipo>: <primeras palabras>» (≤ 80)."""
    clean = re.sub(r"\s+", " ", text).strip()
    name = f"{prefix}: {clean}" if clean else prefix
    return name if len(name) <= MAX_NAME else name[: MAX_NAME - 1].rstrip() + "…"


def concept_name(text: str) -> str:
    """Nombre de un avatar, ángulo o formato: el texto tal cual (≤ 80); el tipo va aparte."""
    clean = re.sub(r"\s+", " ", text).strip()
    clean = re.sub(r"^(avatar|[áa]ngulo|angle|formato|format)\s*:\s*", "", clean, flags=re.IGNORECASE)
    return clean if len(clean) <= MAX_NAME else clean[: MAX_NAME - 1].rstrip() + "…"


def _uuid(*parts: object) -> str:
    return str(uuidlib.UUID(stable_id(*parts)))


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


def _num(metrics: dict[str, Any], key: str) -> float:
    value = metrics.get(key)
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError) as error:
        raise LoopError(f"metrica_invalida:{key}") from error


def window_delta(previous: dict[str, Any] | None, current: dict[str, Any]) -> dict[str, float]:
    """Ventana = lectura actual − lectura anterior (las métricas de SaleADS son acumuladas)."""
    out: dict[str, float] = {}
    for key in ("spend", "purchases", "leads"):
        before = _num(previous or {}, key)
        out[key] = round(max(_num(current, key) - before, 0.0), 2)
    out["cpa"] = round(out["spend"] / out["purchases"], 2) if out["purchases"] else 0.0
    return out


@dataclass
class LoopWriter:
    store: GraphStore
    ledger: Ledger
    # Negocios del dueño (la semilla). Un id que no está ahí ni tiene nada guardado es un error de tipeo, no un
    # negocio nuevo: en la corrida completa 1 un dígito cambiado dejó al cerebro leyendo un negocio vacío.
    known_businesses: Callable[[], set[str]] | None = field(default=None)
    # Verifica la cita del dueño en `state.db` (quotes.check). Sin verificador, la cita queda pendiente.
    quote_checker: quotes.QuoteChecker | None = field(default=None)

    # ---------------------------------------------------------------- apoyo

    def group(self, business_id: str) -> str:
        """Grafo del negocio, validado. No toca el grafo: un id ajeno nunca crea uno (F6)."""
        return self._group(business_id)

    def _group(self, business_id: str) -> str:
        if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", business_id):
            raise LoopError("business_id_invalido")
        group = group_id(business_id)
        known = self.known_businesses() if self.known_businesses else set()
        # `groups()` lista los grafos sin abrirlos; consultar un grafo inexistente lo crea en FalkorDB (los 30 vacíos).
        if known and business_id.lower() not in known and group not in self.store.groups():
            raise LoopError(
                f"negocio_desconocido: {business_id} no es un negocio del dueño; usa uno de {', '.join(sorted(known))}"
            )
        return group

    def _quote(self, owner_quote: str | None) -> tuple[str | None, str]:
        """(cita recortada, estado de quotes). Nunca rechaza."""
        quote = " ".join((owner_quote or "").split())[: quotes.MAX_QUOTE]
        if not quote:
            return None, quotes.NO_QUOTE
        if self.quote_checker is None:
            return quote, quotes.PENDING
        return quote, self.quote_checker(quote)

    def _need(self, group: str, uuid: str, *types: str) -> Node:
        node = self.store.node(group, uuid)
        if node is None or (types and node.type_name not in types):
            raise LoopError(f"ancla_inexistente:{'|'.join(types) or 'nodo'}:{uuid}")
        return node

    def _learning_anchor(self, group: str, anchor_uuid: str) -> Node:
        """Ancla de un aprendizaje: un veredicto o una decisión; con una apuesta, su último veredicto.

        En el E2E simulado Ale inventaba el ancla («campaign_results_2026_11_10») y el cerebro rechazaba todo:
        ahora acepta la apuesta y, si el ancla no existe, el error lista los veredictos para reintentar bien.
        """
        node = self.store.node(group, anchor_uuid.strip())
        if node is not None and node.type_name in ("Verdict", "Decision"):
            return node
        if node is not None and node.type_name == "Bet":
            verdicts = [
                self.store.node(group, e.source)
                for e in self.store.edges_of(group, node.uuid)
                if e.name == "ABOUT" and e.target == node.uuid
            ]
            found = sorted(
                (v for v in verdicts if v is not None and v.type_name == "Verdict"), key=lambda v: v.created_at or ""
            )
            if found:
                return found[-1]
            raise LoopError("apuesta_sin_veredicto: primero el veredicto (brain_record_verdict), luego el aprendizaje")
        recent = sorted(
            (n for n in self.store.nodes(group, 2000) if n.type_name == "Verdict"),
            key=lambda n: n.created_at or "",
            reverse=True,
        )[:5]
        listed = "; ".join(f"{n.uuid} = {n.name}" for n in recent) or "no hay veredictos todavía"
        raise LoopError(
            f"ancla_inexistente: usa el uuid de un veredicto o de su apuesta. Veredictos recientes: {listed}"
        )

    def _concept(self, group: str, type_name: str, label: str, as_of: str) -> Node:
        """Avatar, ángulo o formato por nombre: el mismo texto reutiliza el mismo nodo."""
        label = label.strip()
        if not label:
            raise LoopError(f"falta:{type_name}")
        uuid = _uuid(group, type_name, _norm(label))
        node = self.store.node(group, uuid)
        if node is None:
            node = Node(
                uuid=uuid,
                type_name=type_name,
                # Sin «Avatar:»: con el prefijo, la extracción del día no lo reconoce y lo duplica.
                name=concept_name(label),
                summary=label[:500],
                provenance="inferred",
                verification=VerificationState.PROPOSED.value,
                created_at=as_of,
                attributes={"stage": "en_prueba", "valid_from": as_of},
            )
            self.store.upsert_node(group, node)
        return node

    def _adset(self, group: str, meta_id: str, as_of: str) -> Node:
        meta_id = meta_id.strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", meta_id):
            raise LoopError("adset_id_invalido")
        uuid = _uuid(group, "AdSet", meta_id)
        node = self.store.node(group, uuid)
        if node is None:
            node = Node(
                uuid=uuid,
                type_name="AdSet",
                name=short_name("Caja", meta_id),
                summary="",
                provenance="platform",
                verification=VerificationState.SYSTEM_VERIFIED.value,
                created_at=as_of,
                attributes={"canonical_id": meta_id, "valid_from": as_of},
            )
            self.store.upsert_node(group, node)
        return node

    def _edge(self, group: str, source: str, target: str, name: str, fact: str, as_of: str, provenance: str) -> None:
        self.store.upsert_edge(
            group, Edge(source=source, target=target, name=name, fact=fact[:300], provenance=provenance, valid_at=as_of)
        )

    # ---------------------------------------------------------------- apuesta

    def record_bet(
        self,
        *,
        business_id: str,
        statement: str,
        avatar: str,
        angle: str,
        format: str,
        adset_ids: list[str] | None = None,
        round: int = 1,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        if not statement.strip():
            raise LoopError("falta:statement")
        when, group = _as_of(as_of), self._group(business_id)
        avatar_node = self._concept(group, "Avatar", avatar, when)
        angle_node = self._concept(group, "Angle", angle, when)
        format_node = self._concept(group, "Format", format, when)
        uuid = _uuid(group, "Bet", _norm(statement), round)
        previous = self.store.node(group, uuid)
        linked = previous.attributes.get("saleads_bet_id") if previous is not None else None
        bet = Node(
            uuid=uuid,
            type_name="Bet",
            name=short_name(f"Apuesta v{round}", statement),
            summary=statement[:500],
            provenance="inferred",
            verification=VerificationState.PROPOSED.value,
            created_at=when,
            attributes={
                "stage": "en_prueba",
                "round": round,
                "valid_from": when,
                # MCB-008: volver a registrar la misma apuesta no la desune de SaleADS.
                **({"saleads_bet_id": linked} if linked else {}),
            },
        )
        self.store.upsert_node(group, bet)
        self._edge(group, uuid, avatar_node.uuid, "TARGETS", f"La apuesta le habla a {avatar}", when, "inferred")
        self._edge(group, uuid, angle_node.uuid, "USES", f"La apuesta usa el ángulo {angle}", when, "inferred")
        self._edge(group, uuid, format_node.uuid, "USES", f"La apuesta usa el formato {format}", when, "inferred")
        self._edge(group, angle_node.uuid, avatar_node.uuid, "SPEAKS_WITH", f"{angle} → {avatar}", when, "inferred")
        boxes = [self._adset(group, meta_id, when).uuid for meta_id in adset_ids or []]
        for box in boxes:
            self._edge(group, uuid, box, "TESTED_IN", "La apuesta se prueba en esta caja", when, "platform")
        return {"accepted": True, "bet_uuid": uuid, "adset_uuids": boxes, "name": bet.name}

    def link_bet(self, *, business_id: str, bet_uuid: str, saleads_bet_id: str) -> dict[str, Any]:
        """Une la apuesta del cerebro con su `bet_id` de SaleADS (el que devuelve «apuestas registrar», MCB-008)."""
        group = self._group(business_id)
        saleads_bet_id = saleads_bet_id.strip().lower()
        try:
            uuidlib.UUID(saleads_bet_id)
        except ValueError as error:
            raise LoopError("saleads_bet_id_invalido: usa el bet_id que devolvió apuestas registrar") from error
        node = self.store.node(group, bet_uuid.strip())
        if node is None or node.type_name != "Bet":
            raise LoopError("apuesta_desconocida: usa el bet_uuid que devolvió brain_record_bet")
        current = node.attributes.get("saleads_bet_id")
        if current and str(current) != saleads_bet_id:
            raise LoopError(f"apuesta_ya_unida: esta apuesta ya está unida a {current}")
        if not current:
            self.store.upsert_node(group, _with(node, saleads_bet_id=saleads_bet_id))
        return {"accepted": True, "bet_uuid": node.uuid, "saleads_bet_id": saleads_bet_id}

    def attach_adset(
        self, *, business_id: str, bet_uuid: str, adset_id: str, as_of: str | None = None
    ) -> dict[str, Any]:
        when, group = _as_of(as_of), self._group(business_id)
        self._need(group, bet_uuid, "Bet")
        box = self._adset(group, adset_id, when)
        self._edge(group, bet_uuid, box.uuid, "TESTED_IN", "La apuesta se prueba en esta caja", when, "platform")
        return {"accepted": True, "adset_uuid": box.uuid}

    # -------------------------------------------------------------- resultado

    def _bets_of(self, group: str, adset_uuid: str) -> list[str]:
        return [
            e.source for e in self.store.edges_of(group, adset_uuid) if e.name == "TESTED_IN" and e.target == adset_uuid
        ]

    def _results_of(self, group: str, adset_uuid: str) -> list[Node]:
        out = []
        for edge in self.store.edges_of(group, adset_uuid):
            if edge.name == "GIVES" and edge.source == adset_uuid:
                node = self.store.node(group, edge.target)
                if node is not None:
                    out.append(node)
        return sorted(out, key=lambda n: str(n.attributes.get("read_at", "")))

    def record_result(
        self,
        *,
        business_id: str,
        adset_id: str,
        spend: float,
        purchases: float = 0,
        leads: float = 0,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        when, group = _as_of(as_of), self._group(business_id)
        uuid_box = _uuid(group, "AdSet", adset_id.strip())
        box = self._need(group, uuid_box, "AdSet")
        if not self._bets_of(group, box.uuid):
            raise LoopError("caja_sin_apuesta: conecta la caja a una apuesta antes de leerla")
        current = {"spend": spend, "purchases": purchases, "leads": leads}
        previous = self._results_of(group, box.uuid)
        last = previous[-1].attributes if previous else None
        if last and str(last.get("read_at", "")) >= when:
            raise LoopError("lectura_no_posterior: as_of debe ser posterior a la última lectura")
        delta = window_delta(last, current)
        uuid = _uuid(group, "Result", box.uuid, when)
        summary = (
            f"Acumulado: gasto {spend}, compras {purchases}, leads {leads}. "
            f"Ventana: gasto {delta['spend']}, compras {delta['purchases']}, leads {delta['leads']}, "
            f"CPA {delta['cpa']}."
        )
        node = Node(
            uuid=uuid,
            type_name="Result",
            name=short_name("Lectura", f"{box.attributes.get('canonical_id', '')} {when[:10]}"),
            summary=summary,
            provenance="platform",
            verification=VerificationState.SYSTEM_VERIFIED.value,
            created_at=when,
            attributes={
                "read_at": when,
                "spend": float(spend),
                "purchases": float(purchases),
                "leads": float(leads),
                "cpa": delta["cpa"],
                "window_days": _days(last.get("read_at") if last else None, when),
            },
        )
        self.store.upsert_node(group, node)
        self._edge(group, box.uuid, uuid, "GIVES", summary, when, "platform")
        return {"accepted": True, "result_uuid": uuid, "window": delta}

    # -------------------------------------------------------------- veredicto

    def record_verdict(
        self,
        *,
        business_id: str,
        bet_uuid: str,
        outcome: str,
        reason: str,
        result_uuids: list[str],
        min_spend: float,
        lead_quality: str = "",
        as_of: str | None = None,
    ) -> dict[str, Any]:
        when, group = _as_of(as_of), self._group(business_id)
        if outcome not in OUTCOMES:
            raise LoopError(f"outcome_invalido: usa {', '.join(OUTCOMES)}")
        bet = self._need(group, bet_uuid, "Bet")
        boxes = {
            e.target for e in self.store.edges_of(group, bet.uuid) if e.name == "TESTED_IN" and e.source == bet.uuid
        }
        if not result_uuids:
            raise LoopError("faltan_resultados: un veredicto cita las lecturas de sus cajas")
        window_spend = 0.0
        for uuid in result_uuids:
            result = self._need(group, uuid, "Result")
            box = next((e.source for e in self.store.edges_of(group, uuid) if e.name == "GIVES"), None)
            if box not in boxes:
                raise LoopError("resultado_de_otra_apuesta")
            readings = self._results_of(group, str(box))
            index = next(i for i, n in enumerate(readings) if n.uuid == result.uuid)
            previous = readings[index - 1].attributes if index else None
            window_spend += window_delta(previous, result.attributes)["spend"]
        if outcome in ("gana", "pierde") and window_spend < float(min_spend):
            raise LoopError(f"gasto_minimo_no_alcanzado: {window_spend} < {min_spend}; usa sin_datos o espera")
        text = OUTCOME_TEXT[outcome]
        uuid = _uuid(group, "Verdict", bet.uuid, when)
        node = Node(
            uuid=uuid,
            type_name="Verdict",
            name=short_name("Veredicto", f"{text} · {bet.name}"),
            summary=f"{text.capitalize()}. {reason}".strip()[:500],
            provenance="inferred_from_platform",
            verification=VerificationState.INFERRED.value,
            created_at=when,
            attributes={
                "outcome": outcome,
                "valid_from": when,
                "stage": "concluido",
                "confidence": "media" if lead_quality else "baja",
            },
        )
        self.store.upsert_node(group, node)
        self._edge(group, uuid, bet.uuid, "ABOUT", text, when, "inferred_from_platform")
        for result_uuid in result_uuids:
            self._edge(group, uuid, result_uuid, "DERIVED_FROM", "El veredicto cita esta lectura", when, "platform")
        stage = {"gana": "ganadora", "pierde": "perdedora"}.get(outcome)
        if stage:
            self.store.upsert_node(group, _with(bet, stage=stage))
        return {"accepted": True, "verdict_uuid": uuid, "text": text, "window_spend": round(window_spend, 2)}

    # ----------------------------------------------------------- aprendizaje

    def record_learning(
        self,
        *,
        business_id: str,
        statement: str,
        anchor_uuid: str,
        confidence: str,
        evidence: str,
        replaces_uuid: str | None = None,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        when, group = _as_of(as_of), self._group(business_id)
        if confidence not in CONFIDENCE:
            raise LoopError(f"confidence_invalida: usa {', '.join(CONFIDENCE)}")
        if not statement.strip() or not evidence.strip():
            raise LoopError("faltan_statement_o_evidence")
        anchor = self._learning_anchor(group, anchor_uuid)
        # A lesson inferred from an owner decision is still an inference. It is
        # not a platform measurement and not another decision by the owner.
        derived_provenance = (
            Provenance.INFERRED_FROM_PLATFORM if anchor.type_name == "Verdict" else Provenance.INFERRED
        )
        if anchor.type_name == "Verdict" and anchor.attributes.get("outcome") == "sin_datos":
            # Un «sin datos» no enseña nada del mercado: guardarlo como aprendizaje lo repite en las vueltas siguientes
            # (corrida completa 1, Laura: «es el método de pago» a minutos de encender).
            raise LoopError(
                "aprendizaje_sin_datos: un veredicto sin datos no deja aprendizaje; espera la siguiente lectura"
            )
        refs = [evidence[:300], f"graph:{anchor.uuid}"]
        canonical = "knowledge-" + stable_id(business_id, _norm(statement))
        current = self.ledger.knowledge_at(canonical, valid_at=when, known_at=datetime.now(UTC).isoformat())
        if current and not replaces_uuid:
            revision = self.ledger.reinforce_knowledge(current[0]["revision_id"], refs)
            node = self.store.node(group, str(revision.get("graph_uuid") or ""))
            if node is not None:
                self.store.upsert_node(
                    group, _with(node, evidence_count=int(revision["evidence_count"]), last_evidence_at=when)
                )
            self._link_anchor(group, anchor, str(revision.get("graph_uuid") or ""), when)
            return {
                "accepted": True,
                "learning_uuid": revision.get("graph_uuid"),
                "evidence_count": revision["evidence_count"],
                "reinforced": True,
            }
        prior_revision = None
        old: Node | None = None
        if replaces_uuid:
            old = self._need(group, replaces_uuid, "Learning")
            known = self.ledger.knowledge_by_graph_uuid(old.uuid)
            prior_revision = known["revision_id"] if known and not known["superseded_at"] else None
        revision = self.ledger.record_knowledge(
            business_id=business_id,
            statement=statement,
            provenance=derived_provenance,
            verification=VerificationState.INFERRED,
            evidence_refs=refs,
            valid_from=when,
            supersedes_revision_id=prior_revision,
            confidence=confidence,
        )
        uuid = _uuid(group, "Learning", revision["revision_id"])
        self.ledger.link_knowledge(revision["revision_id"], uuid)
        node = Node(
            uuid=uuid,
            type_name="Learning",
            name=short_name("Aprendizaje", statement),
            summary=statement[:500],
            provenance=derived_provenance.value,
            verification=VerificationState.INFERRED.value,
            created_at=when,
            attributes={
                "confidence": confidence,
                "evidence_count": int(revision["evidence_count"]),
                "learned_at": when,
                "valid_from": when,
                "stage": "vigente",
                "revision_id": revision["revision_id"],
            },
        )
        self.store.upsert_node(group, node)
        self._link_anchor(group, anchor, uuid, when)
        if old is not None:
            self.store.upsert_node(
                group, _with(old, stage="reemplazado", valid_to=when, verification=VerificationState.CONTRADICTED.value)
            )
            self._edge(
                group, uuid, old.uuid, "SUPERSEDES", "Lo reemplaza con evidencia nueva", when, derived_provenance.value
            )
        return {
            "accepted": True,
            "learning_uuid": uuid,
            "evidence_count": int(revision["evidence_count"]),
            "replaced": old.uuid if old else None,
        }

    def _link_anchor(self, group: str, anchor: Node, learning_uuid: str, when: str) -> None:
        if not learning_uuid:
            return
        if anchor.type_name == "Verdict":
            self._edge(
                group, anchor.uuid, learning_uuid, "TEACHES", "El veredicto enseña esto", when, "inferred_from_platform"
            )
        else:
            self._edge(
                group,
                learning_uuid,
                anchor.uuid,
                "DERIVED_FROM",
                "Sale de una decisión del dueño",
                when,
                "inferred",
            )

    # --------------------------------------------------------------- decisión

    def record_decision(
        self,
        *,
        business_id: str,
        text: str,
        scope: list[str],
        about_uuid: str | None = None,
        as_of: str | None = None,
        owner_quote: str | None = None,
    ) -> dict[str, Any]:
        """Corrección o preferencia del dueño, con alcance explícito. Manda sobre lo inferido solo si trae la cita
        literal del dueño, encontrada en su chat y sin eco de Ale. Si no, se guarda igual, como inferida."""
        when, group = _as_of(as_of), self._group(business_id)
        scope = [item.strip() for item in scope if item and item.strip()]
        if not scope:
            raise LoopError("falta_scope: di a qué aplica (p. ej. avatar:mamas, campaña:123, negocio)")
        if not text.strip():
            raise LoopError("falta:text")
        quote, status = self._quote(owner_quote)
        target = self._need(group, about_uuid) if about_uuid else None
        uuid = _uuid(group, "Decision", _norm(text), tuple(sorted(scope)))
        previous = self.store.node(group, uuid)
        validated = status == quotes.OK
        if not validated and previous is not None and previous.provenance == Provenance.OWNER_DECIDED.value:
            # Ya validada con su cita: una repetición sin cita no la degrada.
            node = _with(previous, evidence_count=int(previous.attributes.get("evidence_count") or 1) + 1,
                         last_evidence_at=when)
        else:
            attributes: dict[str, Any] = {"scope": ",".join(scope)[:300], "valid_from": when}
            if quote:
                attributes["owner_quote"] = quote
            if validated and _norm(text) != _norm(quote or ""):
                attributes["interpretation"] = text[:500]
            node = Node(
                uuid=uuid,
                type_name="Decision",
                name=short_name("Decisión del dueño", ", ".join(scope)),
                # Validada, el resumen es la cita: lo que Ale entendió va aparte (sol/hernan, «ni siquiera en pausa»).
                summary=(quote if validated and quote else text)[:500],
                provenance=(Provenance.OWNER_DECIDED if validated else Provenance.INFERRED).value,
                verification=(VerificationState.HUMAN_VALIDATED if validated else VerificationState.INFERRED).value,
                created_at=previous.created_at if previous is not None else when,
                attributes=attributes,
            )
        self.store.upsert_node(group, node)
        if target is not None:
            self._edge(group, uuid, target.uuid, "ABOUT", "La decisión aplica aquí", when, node.provenance)
        return {
            "accepted": True,
            "decision_uuid": uuid,
            "name": node.name,
            "provenance": node.provenance,
            "verification": node.verification,
            "degradado": None if validated else status,
        }

    # ------------------------------------------------------- nota del dueño

    def record_owner_note(
        self,
        *,
        business_id: str,
        text: str,
        provenance: str = "owner_said",
        owner_quote: str | None = None,
        scope: list[str] | None = None,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        """Lo que el dueño dijo o decidió (brain_ingest), en el grafo y con sus palabras. Nunca rechaza por la cita:

        - owner_decided con la cita encontrada y sin eco → Decision validada (record_decision);
        - owner_decided sin cita, con la cita no encontrada o pendiente → OwnerNote owner_said;
        - cita con eco de Ale (en cualquier procedencia) → OwnerNote inferred: owner_said pesa lo mismo que
          owner_decided y es compartible (provenance.py), así que el eco no puede quedar como del dueño.
        """
        when, group = _as_of(as_of), self._group(business_id)
        if provenance not in (Provenance.OWNER_SAID.value, Provenance.OWNER_DECIDED.value):
            raise LoopError("provenance_invalida: usa owner_said u owner_decided")
        text = text.strip()
        if not text:
            raise LoopError("falta:text")
        scope = [item.strip() for item in scope or [] if item and item.strip()] or ["negocio"]
        quote, status = self._quote(owner_quote)
        if provenance == Provenance.OWNER_DECIDED.value and status == quotes.OK:
            out = self.record_decision(business_id=business_id, text=text, scope=scope, as_of=as_of, owner_quote=quote)
            return {**out, "node_uuid": out["decision_uuid"], "type": "Decision"}
        echo = status == quotes.ECHO
        effective = Provenance.INFERRED if echo else Provenance.OWNER_SAID
        uuid = owner_note_uuid(group, text)
        previous = self.store.node(group, uuid)
        if previous is not None:
            # Reforzar en vez de duplicar. Lo inferido sube a owner_said si el dueño lo dice sin eco; nunca baja.
            upgrade = previous.provenance != Provenance.OWNER_SAID.value and not echo
            node = _with(
                previous,
                verification=VerificationState.SELF_REPORTED.value if upgrade else None,
                evidence_count=int(previous.attributes.get("evidence_count") or 1) + 1,
                last_evidence_at=when,
            )
            if upgrade:
                node.provenance = Provenance.OWNER_SAID.value
        else:
            attributes: dict[str, Any] = {"scope": ",".join(scope)[:300], "valid_from": when, "evidence_count": 1}
            if quote:
                attributes["owner_quote"] = quote
            node = Node(
                uuid=uuid,
                type_name="OwnerNote",
                name=short_name("Lo que dijo el dueño", text),
                summary=text[:500],
                provenance=effective.value,
                verification=(VerificationState.INFERRED if echo else VerificationState.SELF_REPORTED).value,
                created_at=when,
                attributes=attributes,
            )
        self.store.upsert_node(group, node)
        # owner_said no necesita cita: sin ella no hay nada degradado.
        quiet = status == quotes.OK or (provenance == Provenance.OWNER_SAID.value and status == quotes.NO_QUOTE)
        degradado = None if quiet else status
        return {
            "accepted": True,
            "node_uuid": uuid,
            "type": "OwnerNote",
            "provenance": node.provenance,
            "verification": node.verification,
            "evidence_count": int(node.attributes.get("evidence_count") or 1),
            "degradado": degradado,
        }


def owner_note_uuid(group: str, text: str) -> str:
    """El mismo texto (sin importar espacios ni mayúsculas) refuerza el mismo nodo."""
    return _uuid(group, "OwnerNote", _norm(text.strip()))


BACKFILL_SOURCE = "mcp://brain_ingest"


def backfill_owner_notes(writer: LoopWriter, ledger: Ledger) -> dict[str, int]:
    """Convierte en OwnerNote lo que brain_ingest dejó solo en `events` antes de MCB-009. Idempotente: un evento
    cuyo nodo ya existe no se toca. Todo va como owner_said (esos eventos no traen cita: nunca se elevan a
    decisión). Un negocio desconocido se salta sin crear su grafo."""
    with closing(ledger.connect()) as db:
        rows = db.execute(
            "SELECT business_id, occurred_at, payload_json FROM events WHERE kind = 'owner_message' AND source_uri = ? "
            "ORDER BY occurred_at",
            (BACKFILL_SOURCE,),
        ).fetchall()
    groups = set(writer.store.groups())
    created = skipped = rejected = 0
    for row in rows:
        payload = json.loads(row["payload_json"])
        text = str(payload.get("text") or "").strip() if isinstance(payload, dict) else ""
        if not text or payload.get("graph_uuid"):  # con graph_uuid ya lo escribió brain_ingest en el grafo
            skipped += 1
            continue
        try:
            group = writer.group(str(row["business_id"]))
        except LoopError:
            rejected += 1
            continue
        if group in groups and writer.store.node(group, owner_note_uuid(group, text)) is not None:
            skipped += 1
            continue
        writer.record_owner_note(
            business_id=str(row["business_id"]), text=text, provenance="owner_said", as_of=str(row["occurred_at"])
        )
        groups.add(group)
        created += 1
    return {"created": created, "skipped": skipped, "rejected": rejected}


def _with(node: Node, verification: str | None = None, **attributes: Any) -> Node:
    return Node(
        uuid=node.uuid,
        type_name=node.type_name,
        name=node.name,
        summary=node.summary,
        provenance=node.provenance,
        verification=verification or node.verification,
        created_at=node.created_at,
        attributes={**node.attributes, **attributes},
        mentions=node.mentions,
    )


def _days(previous: Any, current: str) -> int:
    if not previous:
        return 0
    try:
        delta = datetime.fromisoformat(current) - datetime.fromisoformat(str(previous))
    except ValueError:
        return 0
    return max(int(delta.total_seconds() // 86_400), 0)
