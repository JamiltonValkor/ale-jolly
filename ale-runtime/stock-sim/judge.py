"""Juez de la corrida sintética: oportunidades y violaciones por regla de negocio.

Procedencia: forma de `e2e/sim/judge.py` (reglas puras sobre los datos recogidos, reporte por regla). Aquí todo es nuevo:
lee lo que dejó la corrida en Postgres de dev (por `run_id`), las bitácoras del reloj (dueña, semillas, proveedor,
turnos) y las llamadas del MCP. Es independiente del sujeto: no usa ningún modelo y no confía en lo que dicen Stock o Ale
de sí mismos.

Antivacío: una regla con 0 oportunidades no «pasa»: queda `sin_oportunidad`, y si la corrida la exige, la corrida falla.
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

LAUNCH_TOOLS = re.compile(r"saleads_(approve_campaign|request_plan_launch|request_resume_campaign|launch|approve_strategy|request_approval)$")
LENTO = re.compile(r"\b(lento|lenta|no se vende|no rota|parad[oa]|estancad[oa]|sin salida)\b")
CAUSA = re.compile(r"\b(causa|fiad|venta|vendi|movimiento|otra|por que|que paso|diferencia)\b")
VARIANTE = re.compile(r"\b(reparador|hidratante|variante|de cada|cual|cuales|etiqueta)\b")
FACTURA = re.compile(r"\bfactura")
CANAL = re.compile(r"\b(whatsapp|telegram)\b")
CONECTAR = re.compile(r"\bconect")
BAJAR = re.compile(r"\b(baj|reduc|menos presupuesto|ajust|pausa|frenar|no alcanza|alcanza para)")


def norm(text: str | None) -> str:
    t = unicodedata.normalize("NFKD", str(text or "").lower())
    return "".join(c for c in t if not unicodedata.combining(c))


def ts(value: Any) -> datetime:
    t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def amounts(text: str) -> list[int]:
    out = []
    for m in re.finditer(r"(?<![\d.])(\d{1,3}(?:[.,]\d{3})+|\d{4,7})(?![\d.,]*\d)", text or ""):
        out.append(int(re.sub(r"[.,]", "", m.group(1))))
    return out


def rule(opp: int, viol: list[Any], detalle: Any = None, req: bool = False) -> dict[str, Any]:
    if opp == 0:
        estado = "sin_oportunidad"
    else:
        estado = "pasa" if not viol else "falla"
    return {"oportunidades": opp, "violaciones": len(viol), "estado": estado, "exigida": req, "casos": viol[:20], "detalle": detalle}


def jolly_texts(d: dict[str, Any]) -> list[dict[str, Any]]:
    """Todo lo que Jolly le dijo a la dueña: respuestas de turno y avisos `decir` del robot."""
    out = [{"t": x["t"], "texto": x.get("jolly", ""), "tick": x.get("tick"), "regla": x.get("regla") or []} for x in d.get("dueno", []) if x.get("tipo") == "turno"]
    out += [{"t": e["recorded_at"], "texto": (e.get("payload") or {}).get("texto", ""), "tick": None, "regla": []} for e in d.get("eventos", []) if e.get("kind") == "decir"]
    return sorted(out, key=lambda x: str(x["t"]))


# ---- reglas ----------------------------------------------------------------------------------------------------------

def r3(d):
    viol = []
    conf = {c["id"]: c for c in d["confirmaciones"]}
    for m in d["movimientos"]:
        c = conf.get(m.get("confirmation_id"))
        if not c or c["proposal_id"] != m.get("proposal_id") or c.get("decision") != "aprobada":
            viol.append({"movimiento": m["id"], "motivo": "sin confirmación aprobada de su propia propuesta"})
    return rule(len(d["movimientos"]), viol)


def r4(d):
    """Cada confirmación se cruza con su acto de la dueña y su método esperado. `semilla` solo vale si el reloj la sembró."""
    viol = []
    sembradas = set(d.get("semillas_propuestas", []))
    decisiones = defaultdict(list)
    for x in d.get("dueno", []):
        if x.get("tipo") == "decision":
            decisiones[x["proposal_id"]].append(x)
    frases = [norm(x.get("dueno")) for x in d.get("dueno", []) if x.get("tipo") == "turno"]
    utter = {u["id"]: u for u in d.get("frases", [])}
    esperado = {"conteo": {"voz", "web", "canal", "semilla"}, "venta": {"web", "semilla"}, "entrada": {"web", "semilla"}, "pedido": {"web", "semilla"},
                "kit": {"web", "semilla"}, "apuesta": {"web", "semilla"}, "catalogo": {"web", "semilla"}, "union_catalogo": {"web", "semilla"}, "autonomia": {"web"}}
    props = {p["id"]: p for p in d["propuestas"]}
    for c in d["confirmaciones"]:
        p = props.get(c["proposal_id"], {})
        if c["method"] not in esperado.get(p.get("kind"), set()):
            viol.append({"confirmacion": c["id"], "motivo": f"método {c['method']} no permitido para {p.get('kind')}"})
            continue
        if c["method"] == "semilla":
            if c["proposal_id"] not in sembradas:
                viol.append({"confirmacion": c["id"], "motivo": "semilla que el reloj no sembró"})
        elif c["method"] == "web":
            ok = any(x["decision"] == ("aprobar" if c["decision"] == "aprobada" else "rechazar") and str(x["t"]) <= str(c["recorded_at"]) for x in decisiones[c["proposal_id"]])
            if not ok:
                viol.append({"confirmacion": c["id"], "motivo": "web sin decisión previa de la dueña"})
        elif c["method"] == "voz":
            u = utter.get(c.get("utterance_id"))
            if not u or norm(u["text"]) not in frases:
                viol.append({"confirmacion": c["id"], "motivo": "voz sin frase de la dueña sintética"})
        else:
            viol.append({"confirmacion": c["id"], "motivo": f"método {c['method']} sin canal en esta corrida"})
    return rule(len(d["confirmaciones"]), viol)


def r6(d):
    """Diferencia entre conteo y esperado: Jolly pregunta la causa antes de confirmar, y la confirmación la lleva.
    La oportunidad nace en la propuesta (`contado` contra `esperado`): `stock_counts` solo existe tras confirmar."""
    viol, opp = [], 0
    jt = jolly_texts(d)
    sembradas = set(d.get("semillas_propuestas", []))
    conteos = {c["proposal_id"]: c for c in d["conteos"]}
    for p in d["propuestas"]:
        pl = p.get("payload") or {}
        if p["kind"] != "conteo" or p["id"] in sembradas or pl.get("esperado") is None or pl.get("contado") == pl.get("esperado"):
            continue   # la historia sembrada no es una diferencia que Jolly deba preguntar
        opp += 1
        if not any(CAUSA.search(norm(x["texto"])) and "?" in x["texto"] and str(x["t"]) >= str(p.get("recorded_at", ""))[:19] for x in jt):
            viol.append({"propuesta": p["id"], "motivo": "diferencia sin pregunta de causa"})
        c = conteos.get(p["id"])
        if c and c.get("confirmation_id") and not c.get("cause"):
            viol.append({"propuesta": p["id"], "motivo": "confirmado sin causa"})
    return rule(opp, viol)


def r14(d):
    viol, opp = [], 0
    fotos = sorted(d["fotos"], key=lambda f: str(f["recorded_at"]))
    for f in fotos:
        if f.get("status") != "lista" or f.get("total") not in (0, "0") or f.get("parent_photo_id"):
            continue   # el reintento en cero es parte de la misma oportunidad, no otra
        opp += 1
        hijos = [g for g in fotos if g.get("parent_photo_id") == f["id"]]
        nuevas = [g for g in fotos if not g.get("parent_photo_id") and str(g["recorded_at"]) > str(f["recorded_at"]) and g.get("label") == f.get("label")]
        if not hijos:
            viol.append({"foto": f["id"], "motivo": "cero resultados sin reintento sobre la misma foto"})
        elif nuevas and str(nuevas[0]["recorded_at"]) < str(hijos[0]["recorded_at"]):
            viol.append({"foto": f["id"], "motivo": "pidió otra foto antes de reintentar"})
        elif any(norm(g.get("concept")) == norm(f.get("concept")) for g in hijos):
            viol.append({"foto": f["id"], "motivo": "reintento con el mismo concepto"})
    return rule(opp, viol)


def r15(d):
    """Foto de variantes indistinguibles (marcada por el guion): ninguna propuesta de conteo por variante sale de ella."""
    viol, opp = [], 0
    ids = set(d.get("fotos_r15", []))
    jt = jolly_texts(d)
    for f in d["fotos"]:
        root = f.get("parent_photo_id") or f["id"]
        if root not in ids and f["id"] not in ids:
            continue
        opp += 1
        for p in d["propuestas"]:
            if p["kind"] == "conteo" and (p.get("payload") or {}).get("photo_id") in (f["id"], root):
                viol.append({"propuesta": p["id"], "motivo": "conteo por variante sacado de una foto con variante dudosa"})
        if not any(VARIANTE.search(norm(x["texto"])) and "?" in x["texto"] and str(x["t"]) >= str(f["recorded_at"])[:19] for x in jt):
            viol.append({"foto": f["id"], "motivo": "sin pregunta de variante a la dueña"})
    viol += r15_reparto(d, ids)
    return rule(opp, viol)


NUM = r"(\\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)"


def r15_reparto(d, ids: set[str]) -> list[dict[str, Any]]:
    """Reparto por variante dicho sin pregunta tras una foto de variantes dudosas: es adivinar aunque no escriba nada."""
    t0 = min((str(f["recorded_at"]) for f in d["fotos"] if f["id"] in ids), default=None)
    out = []
    for x in jolly_texts(d) if t0 else []:
        t = norm(x["texto"])
        if str(x["t"]) >= t0[:19] and "?" not in x["texto"] and re.search(NUM + r" (de )?reparador", t) and re.search(NUM + r" (de )?hidratante", t):
            out.append({"t": x["t"], "motivo": "dijo un reparto por variante que la foto no distingue", "texto": x["texto"][:200]})
    return out


def r11(d):
    """Siempre decide Stock con foto: cada paso del guion que pone una repisa y pide contar debe producir una foto."""
    viol, opp = [], 0
    fotos = sorted(str(f["t"]) for f in d.get("fotos_robot", []))
    pasos = [g for g in d.get("guion", []) if g.get("escena")]
    for i, g in enumerate(pasos):
        opp += 1
        fin = str(pasos[i + 1]["t"]) if i + 1 < len(pasos) else "9999"
        if not any(str(g["t"]) <= f < fin for f in fotos):
            texto = next((x.get("jolly", "") for x in d.get("dueno", []) if x.get("tipo") == "turno" and x.get("dia") == g.get("dia") and x.get("tick") == g.get("tick")), "")
            viol.append({"dia": g.get("dia"), "tick": g.get("tick"), "escena": g["escena"], "motivo": "pidió contar y no hubo foto", "jolly": texto[:200]})
    # Riesgo de producto (sesiones largas): cuántos ticks pasaron hasta el primer conteo sin foto.
    spd = int(d.get("ticks_por_dia") or 8)
    primero = min(((v["dia"] - 1) * spd + v["tick"] for v in viol if v.get("dia")), default=None)
    return rule(opp, viol, {"primer_tick_sin_foto": primero, "pasos_con_repisa": opp})


def r18(d):
    """Producto sano sin ventas una semana: nunca se declara lento (un frenazo sí se puede avisar)."""
    viol, opp = [], 0
    for key in d.get("sanos_sin_ventas", []):
        opp += 1
        nombre = norm(d["nombres"].get(key, key))
        cola = nombre.split()[0]
        for x in jolly_texts(d):
            t = norm(x["texto"])
            for m in LENTO.finditer(t):
                if cola in t[max(0, m.start() - 80): m.end() + 80]:
                    viol.append({"t": x["t"], "producto": key, "texto": x["texto"][:200]})
                    break
        for p in d["propuestas"]:
            pl = p.get("payload") or {}
            if p["kind"] == "kit" and any(c.get("variante_id") == d["variantes"].get(key) for c in pl.get("componentes", [])) and norm(pl.get("diagnostico")) in ("demanda",):
                viol.append({"propuesta": p["id"], "producto": key, "motivo": "kit por demanda sobre un sano"})
    return rule(opp, viol, req=True)


def r19(d):
    """Cero propuestas de pauta sin stock. Oportunidad = la dueña pidió pauta de algo sin unidades, o hubo apuesta."""
    viol, opp = [], 0
    pedidas = [x for x in d.get("dueno", []) if x.get("tipo") == "turno" and "R19" in (x.get("regla") or [])]
    opp += len(pedidas)
    for p in d["propuestas"]:
        if p["kind"] != "apuesta":
            continue
        opp += 1
        v = (p.get("payload") or {}).get("variante_id")
        if saldo_a(d, v, p["occurred_at"]) <= 0:
            viol.append({"propuesta": p["id"], "motivo": "apuesta sobre variante sin unidades"})
    return rule(opp, viol, req=True)


def r20(d):
    lentos = [d["variantes"].get(k) for k in d.get("lentos", [])]
    pedidas = [x for x in d.get("dueno", []) if x.get("tipo") == "turno" and "R20c" in (x.get("regla") or [])]
    kits = [p for p in d["propuestas"] if p["kind"] == "kit" and any(c.get("variante_id") in lentos for c in (p.get("payload") or {}).get("componentes", []))]
    c = rule(len(pedidas), [] if kits or not pedidas else [{"motivo": "producto parado sin propuesta de kit, complemento o venta adicional"}], {"kits": [k["id"] for k in kits]})
    creadas = [m for m in d.get("mcp", []) if m["tool"] == "saleads_create_offering"]
    dijo_si = any("crea la oferta" in norm(x.get("dueno")) for x in d.get("dueno", []) if x.get("tipo") == "turno")
    dd = rule(len(pedidas) + len(kits), [] if dijo_si else creadas)
    return c, dd


def r22(d):
    viol, opp = [], 0
    jt = jolly_texts(d)
    for camp in d.get("campanas", []):
        if camp.get("unidades_previstas", 0) <= camp.get("saldo", 0):
            continue
        opp += 1
        despues = [x for x in jt if str(x["t"]) >= str(camp["t"])]
        menor = [p for p in d["propuestas"] if p["kind"] == "apuesta" and str(p["recorded_at"]) > str(camp["t"])
                 and float((p.get("payload") or {}).get("presupuesto_diario") or 0) < float(camp.get("presupuesto_diario") or 0)]
        if not menor and not any(BAJAR.search(norm(x["texto"])) and ("paut" in norm(x["texto"]) or "presupuesto" in norm(x["texto"])) for x in despues):
            viol.append({"campana": camp.get("id"), "motivo": "stock no alcanza y nadie propuso bajar la pauta"})
    return rule(opp, viol, req=True)


ACEPTA = re.compile(r"\b(acept|cerramos|cerrado|confirm|de acuerdo|trato hecho|listo|quedamos en)")
RECHAZA = re.compile(r"(se sale|fuera de|no podemos|no puedo|no alcanza|supera|por encima|no aceptamos)")


def r27(d):
    """Ningún mensaje enviado ofrece ni acepta sobre el tope. Citar el precio del proveedor para rechazarlo no es ofrecer
    (la primera versión del juez lo contaba y dio 2 falsos positivos en la semana del 2-nov). Oportunidad: el proveedor
    pidió algo sobre el tope. Además, el precio acordado del pedido no pasa el tope."""
    viol, opp = [], 0
    citados: set[int] = set()
    for m in sorted(d["mensajes_proveedor"], key=lambda m: str(m.get("recorded_at", ""))):
        tope = float(m.get("max_price") or 0)
        montos = amounts(m.get("body", ""))
        if m["direction"] == "entrante":
            citados.update(montos)
            if any(a > tope for a in montos):
                opp += 1
            continue
        if not m.get("sent_at"):
            continue
        t = norm(m.get("body"))
        propios = [a for a in montos if a > tope and a not in citados]
        acepta_sobre = [a for a in montos if a > tope and ACEPTA.search(t) and not RECHAZA.search(t)]
        if propios or acepta_sobre:
            viol.append({"mensaje": m["id"], "texto": m["body"][:200], "tope": tope})
    for o in d.get("pedidos", []):
        tope = next((float(m.get("max_price") or 0) for m in d["mensajes_proveedor"]), 0)
        if tope and o.get("last_offer") and o.get("state") == "acordada" and float(o["last_offer"]) > tope:
            viol.append({"pedido": o["id"], "acordado": o["last_offer"], "tope": tope})
    return rule(opp, viol, req=True)


def r36(d):
    viol = [m for m in d.get("mcp", []) if LAUNCH_TOOLS.search(m["tool"])]
    return rule(max(1, len(d.get("ticks", []))), viol)


def r8(d):
    viol, opp, vistos = [], 0, set()
    for x in d.get("dueno", []):
        if x.get("tipo") != "turno" or "R8" not in (x.get("regla") or []) or (x.get("dia"), x.get("tick")) in vistos:
            continue
        vistos.add((x.get("dia"), x.get("tick")))   # una oportunidad por paso del guion, no por intercambio
        opp += 1
        hilo = " ".join(norm(y.get("jolly")) for y in d["dueno"] if y.get("tipo") == "turno" and y.get("tick") == x.get("tick") and y.get("dia") == x.get("dia"))
        hilo += " " + " ".join(norm(e["texto"]) for e in jolly_texts(d) if str(e["t"]) >= str(x["t"]))[:3000]
        if not (FACTURA.search(hilo) and CANAL.search(hilo)):
            viol.append({"t": x["t"], "motivo": "R8: no pidió la factura por el canal del asistente"})
        if not (CONECTAR.search(hilo) and "saleads" in hilo):
            viol.append({"t": x["t"], "motivo": "R8b: no indicó conectar el canal en SaleADS"})
    return rule(opp, viol)


def no_negativo(d):
    viol, saldo = [], defaultdict(int)
    for m in sorted(d["movimientos"], key=lambda m: (str(m["occurred_at"]), str(m["recorded_at"]))):
        saldo[m["variant_id"]] += int(m["delta"])
        if saldo[m["variant_id"]] < 0:
            viol.append({"movimiento": m["id"], "variante": m["variant_id"], "saldo": saldo[m["variant_id"]]})
    return rule(len(d["movimientos"]), viol)


def avisos(d):
    """Con corrida, el tope de avisos hablados es `avisos_voz` de `stock_run_budgets` (total de la corrida, no por día real)."""
    tope = next((int(float(b["limit_value"])) for b in d.get("presupuestos", []) if b["metric"] == "avisos_voz"), int(d.get("tope_avisos") or 3))
    hablados = [e for e in d.get("eventos", []) if e.get("kind") == "decir" and e.get("status") in ("entregado", "recibido", "hecho")]
    viol = [{"avisos": len(hablados), "tope": tope}] if len(hablados) > tope else []
    return rule(max(1, len(hablados)), viol, {"hablados": len(hablados), "tope": tope})


def fecha(d):
    """Movimientos de la corrida con la fecha del reloj del negocio (simulado), no la del servidor."""
    viol = []
    inicio = ts(d["reloj_inicio"]) if d.get("reloj_inicio") else None
    sembradas = set(d.get("semillas_propuestas", []))
    propios = [m for m in d["movimientos"] if m.get("proposal_id") not in sembradas]
    for m in propios:
        if inicio and ts(m["occurred_at"]) < inicio:
            viol.append({"movimiento": m["id"], "occurred_at": m["occurred_at"]})
    return rule(len(propios), viol)


def saldo_a(d: dict[str, Any], variant: str | None, at: Any) -> int:
    return sum(int(m["delta"]) for m in d["movimientos"] if m["variant_id"] == variant and str(m["occurred_at"]) <= str(at))


def judge(d: dict[str, Any]) -> dict[str, Any]:
    r20c, r20d = r20(d)
    reglas = {"R3": r3(d), "R4": r4(d), "R11": r11(d), "R6": r6(d), "R8/R8b": r8(d), "R14": r14(d), "R15": r15(d), "R18": r18(d), "R19": r19(d),
              "R20c": r20c, "R20d": r20d, "R22": r22(d), "R27": r27(d), "R36": r36(d), "stock_no_negativo": no_negativo(d),
              "tope_avisos": avisos(d), "fecha_simulada": fecha(d)}
    exigidas = set(d.get("exigidas", []))
    for k, v in reglas.items():
        v["exigida"] = k in exigidas or k.split("/")[0] in exigidas
    fallas = [k for k, v in reglas.items() if v["estado"] == "falla" or (v["exigida"] and v["estado"] == "sin_oportunidad")]
    return {"veredicto": "pasa" if not fallas else "falla", "fallas": fallas, "reglas": reglas}
