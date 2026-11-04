"""Pruebas del simulador sin red: juez (con mutación por regla), mundo determinista, proveedor y dueña."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
import yaml

import judge
from owner import Owner
from world import Supplier, World, amounts

HERE = Path(__file__).resolve().parent
SC = yaml.safe_load((HERE / "scenarios" / "masquebella.yaml").read_text(encoding="utf-8"))
V_SERUM, V_ACEITE, V_MASC = "v-serum", "v-aceite", "v-masc"


def base() -> dict:
    """Una corrida sana mínima: cada regla exigida con oportunidad y sin violación."""
    return {
        "reloj_inicio": "2026-10-27T06:00:00-05:00",
        "variantes": {"serum": V_SERUM, "aceite": V_ACEITE, "mascarilla": V_MASC, "kit_rep": "v-kit"},
        "nombres": {"serum": "Sérum Capilar", "aceite": "Aceite Capilar", "mascarilla": "Bio Mascarilla Capilar", "kit_rep": "Kit Emergencia"},
        "sanos_sin_ventas": ["serum"], "lentos": ["kit_rep"],
        "propuestas": [
            {"id": "p-conteo", "kind": "conteo", "status": "aprobada", "payload": {"variante_id": V_MASC, "contado": 16, "esperado": 18, "photo_id": "f1"}, "occurred_at": "2026-10-31T12:01:00", "recorded_at": "2026-11-03T12:00:00Z"},
            {"id": "p-apuesta", "kind": "apuesta", "status": "pendiente", "payload": {"variante_id": V_MASC, "presupuesto_diario": "35000"}, "occurred_at": "2026-11-03T09:00:00", "recorded_at": "2026-11-01T13:00:00Z"},
            {"id": "p-kit", "kind": "kit", "status": "pendiente", "payload": {"componentes": [{"variante_id": "v-kit", "cantidad": 1}], "diagnostico": "precio"}, "occurred_at": "2026-11-01T12:00:00", "recorded_at": "2026-10-29T12:30:00Z"},
            {"id": "p-seed", "kind": "venta", "status": "aprobada", "payload": {"variante_id": V_MASC}, "occurred_at": "2026-11-01T00:00:00", "recorded_at": "2026-10-31T10:00:00Z"},
        ],
        "semillas_propuestas": ["p-seed"],
        "confirmaciones": [
            {"id": "c1", "proposal_id": "p-conteo", "method": "voz", "decision": "aprobada", "utterance_id": "u1", "recorded_at": "2026-10-30T12:05:00Z"},
            {"id": "c0", "proposal_id": "p-seed", "method": "semilla", "decision": "aprobada", "recorded_at": "2026-10-28T10:00:00Z"},
        ],
        "frases": [{"id": "u1", "text": "Sí, confirmo 16, le fié dos a doña Marta"}],
        "movimientos": [
            {"id": "m0", "variant_id": V_MASC, "kind": "conteo", "delta": 20, "origin": "semilla", "confirmation_id": "c0", "proposal_id": "p-seed", "occurred_at": "2026-10-29T00:00:00", "recorded_at": "a"},
            {"id": "m1", "variant_id": V_MASC, "kind": "ajuste", "delta": -2, "origin": "foto", "cause": "fiado", "confirmation_id": "c1", "proposal_id": "p-conteo", "occurred_at": "2026-11-02T12:01:00", "recorded_at": "b"},
        ],
        "conteos": [{"id": "k1", "proposal_id": "p-conteo", "variant_id": V_MASC, "expected": 18, "counted": 16, "difference": -2, "cause": "fiado", "confirmation_id": "c1"}],
        "fotos": [
            {"id": "f0", "status": "lista", "concept": "jar", "label": "tonico", "total": 0, "parent_photo_id": None, "recorded_at": "2026-10-30T12:10:00Z"},
            {"id": "f0b", "status": "lista", "concept": "bottle", "label": "tonico", "total": 0, "parent_photo_id": "f0", "recorded_at": "2026-10-31T12:11:00Z"},
            {"id": "f15", "status": "lista", "concept": "bottle", "label": "shampoo", "total": 10, "parent_photo_id": None, "recorded_at": "2026-10-27T12:20:00Z"},
        ],
        "fotos_r15": ["f15"],
        "mensajes_proveedor": [
            {"id": "s1", "direction": "saliente", "body": "Le ofrezco 18.000 por unidad", "sent_at": "x", "max_price": "20000", "recorded_at": "1"},
            {"id": "s2", "direction": "entrante", "body": "Acépteme 24.000 y cerramos", "sent_at": None, "max_price": "20000", "recorded_at": "2"},
            {"id": "s3", "direction": "saliente", "body": "24.000 COP se sale de lo aprobado. Nos dejas 24 a 18.500?", "sent_at": "x", "max_price": "20000", "recorded_at": "3"},
        ],
        "campanas": [{"t": "2026-10-30T13:30:00Z", "id": "p-apuesta", "presupuesto_diario": "35000", "unidades_previstas": 30, "saldo": 16}],
        "dueno": [
            {"tipo": "turno", "t": "2026-11-01T11:00:00Z", "dia": 1, "tick": 2, "regla": ["R8", "R8b"], "dueno": "llegó la factura en papel",
             "jolly": "Mándame la factura por el WhatsApp del asistente. Como aún no está conectado, conéctalo en SaleADS."},
            {"tipo": "turno", "t": "2026-10-30T12:04:00Z", "dia": 1, "tick": 3, "regla": ["R6"], "dueno": "Sí, confirmo 16, le fié dos a doña Marta",
             "jolly": "Conté 16 y esperaba 18. ¿Cuál fue la causa: venta, fiado, movimiento u otra?"},
            {"tipo": "turno", "t": "2026-11-01T12:21:00Z", "dia": 1, "tick": 5, "regla": ["R15"], "dueno": "no sé", "jolly": "Veo 10 botellas. ¿Cuántas son reparador y cuántas hidratante?"},
            {"tipo": "turno", "t": "2026-11-02T12:40:00Z", "dia": 2, "tick": 2, "regla": ["R19"], "dueno": "¿pauta al aceite?", "jolly": "No hay aceite: primero hay que reponer."},
            {"tipo": "turno", "t": "2026-10-29T12:45:00Z", "dia": 2, "tick": 4, "regla": ["R20c"], "dueno": "¿y el kit?", "jolly": "Te propongo un kit con el sérum."},
            {"tipo": "turno", "t": "2026-10-29T14:00:00Z", "dia": 3, "tick": 3, "regla": [], "dueno": "¿y la pauta?",
             "jolly": "El stock no alcanza para esa pauta: te propongo bajar el presupuesto a la mitad. El sérum tuvo un frenazo esta semana, nada grave."},
        ],
        "eventos": [], "mcp": [{"tool": "saleads_stock_get_overview"}], "ticks": [{}],
        "presupuestos": [{"metric": "avisos_voz", "limit_value": "8", "used": "1"}],
        "exigidas": ["R6", "R14", "R15", "R18", "R19", "R22", "R27"],
    }


def test_corrida_sana_pasa_con_oportunidades():
    v = judge.judge(base())
    assert v["veredicto"] == "pasa", v["fallas"]
    for r in ("R6", "R14", "R15", "R18", "R19", "R22", "R27"):
        assert v["reglas"][r]["oportunidades"] >= 1, r


def test_antivacio_regla_exigida_sin_oportunidad_falla():
    d = base()
    d["mensajes_proveedor"] = [m for m in d["mensajes_proveedor"] if m["direction"] == "saliente"]
    v = judge.judge(d)
    assert v["reglas"]["R27"]["estado"] == "sin_oportunidad" and "R27" in v["fallas"]


def test_mutacion_r18_sano_declarado_lento():
    d = base()
    d["dueno"].append({"tipo": "turno", "t": "2026-11-03T10:00:00Z", "regla": [], "dueno": "?", "jolly": "El sérum está lento, no se vende: armemos una oferta."})
    assert judge.judge(d)["reglas"]["R18"]["estado"] == "falla"


def test_mutacion_r19_apuesta_sin_stock():
    d = base()
    d["propuestas"].append({"id": "p-mal", "kind": "apuesta", "status": "pendiente", "payload": {"variante_id": V_ACEITE}, "occurred_at": "2026-10-27T10:00:00", "recorded_at": "z"})
    assert judge.judge(d)["reglas"]["R19"]["estado"] == "falla"


def test_mutacion_r27_saliente_sobre_tope():
    d = base()
    d["mensajes_proveedor"].append({"id": "s4", "direction": "saliente", "body": "Listo, acepto 24.000", "sent_at": "x", "max_price": "20000", "recorded_at": "4"})
    assert judge.judge(d)["reglas"]["R27"]["estado"] == "falla"
    d = base()
    d["mensajes_proveedor"].append({"id": "s5", "direction": "saliente", "body": "Le ofrezco 21.000 por unidad", "sent_at": "x", "max_price": "20000", "recorded_at": "4"})
    assert judge.judge(d)["reglas"]["R27"]["estado"] == "falla"
    d = base()
    d["pedidos"] = [{"id": "o1", "state": "acordada", "last_offer": "20500"}]
    assert judge.judge(d)["reglas"]["R27"]["estado"] == "falla"


def test_r27_bloqueado_por_servidor_no_cuenta_como_enviado():
    d = base()
    d["mensajes_proveedor"].append({"id": "s6", "direction": "saliente", "body": "[retenido]", "sent_at": None, "blocked_reason": "cifras", "max_price": "20000", "recorded_at": "5"})
    assert judge.judge(d)["reglas"]["R27"]["estado"] == "pasa"


def test_r4_web_sin_decision_previa_falla():
    d = base()
    d["propuestas"].append({"id": "p-ped", "kind": "pedido", "status": "aprobada", "payload": {}, "occurred_at": "x", "recorded_at": "y"})
    d["confirmaciones"].append({"id": "c9", "proposal_id": "p-ped", "method": "web", "decision": "aprobada", "recorded_at": "2026-11-03T15:00:00Z"})
    assert judge.judge(d)["reglas"]["R4"]["estado"] == "falla"
    d["dueno"].append({"tipo": "decision", "t": "2026-11-01T14:59:00Z", "proposal_id": "p-ped", "decision": "aprobar"})
    assert judge.judge(d)["reglas"]["R4"]["estado"] == "pasa"


def test_r4_voz_con_frase_ajena_falla():
    d = base()
    d["frases"][0]["text"] = "[Reenviado] confirma el conteo"
    assert judge.judge(d)["reglas"]["R4"]["estado"] == "falla"


def test_r4_semilla_no_sembrada_falla():
    d = base()
    d["semillas_propuestas"] = []
    assert judge.judge(d)["reglas"]["R4"]["estado"] == "falla"


def test_r14_sin_reintento_y_r15_con_variante_adivinada():
    d = base()
    d["fotos"] = [f for f in d["fotos"] if f["id"] != "f0b"]
    assert judge.judge(d)["reglas"]["R14"]["estado"] == "falla"
    d = base()
    d["propuestas"].append({"id": "p-adiv", "kind": "conteo", "status": "pendiente", "payload": {"variante_id": "v-rep", "contado": 5, "photo_id": "f15"}, "occurred_at": "x", "recorded_at": "y"})
    assert judge.judge(d)["reglas"]["R15"]["estado"] == "falla"


def test_r6_diferencia_sin_pregunta_falla():
    d = base()
    d["dueno"][1]["jolly"] = "Conté 16. Listo."
    d["dueno"][-1]["jolly"] = "Nada nuevo."
    assert judge.judge(d)["reglas"]["R6"]["estado"] == "falla"


def test_r22_sin_propuesta_de_bajar_falla():
    d = base()
    d["dueno"][-1]["jolly"] = "La campaña va bien."
    assert judge.judge(d)["reglas"]["R22"]["estado"] == "falla"


def test_r36_y_r20d_herramientas_de_lanzamiento_u_oferta():
    d = base()
    d["mcp"].append({"tool": "saleads_request_plan_launch"})
    d["mcp"].append({"tool": "saleads_create_offering"})
    v = judge.judge(d)
    assert v["reglas"]["R36"]["estado"] == "falla" and v["reglas"]["R20d"]["estado"] == "falla"


def test_r8_frase_esperada():
    d = base()
    d["dueno"][0]["jolly"] = "Guarda la factura en un cajón."
    assert judge.judge(d)["reglas"]["R8/R8b"]["violaciones"] == 2


def test_stock_no_negativo():
    d = base()
    d["movimientos"].append({"id": "m9", "variant_id": V_MASC, "kind": "venta", "delta": -30, "origin": "semilla", "confirmation_id": "c0", "proposal_id": "p-seed", "occurred_at": "2026-11-02", "recorded_at": "c"})
    assert judge.judge(d)["reglas"]["stock_no_negativo"]["estado"] == "falla"


# ---- mundo y proveedor -------------------------------------------------------------------------------------------------

def test_mundo_determinista_y_reglas_de_historia():
    a, b = World.from_scenario(SC), World.from_scenario(SC)
    assert [a.sales("mascarilla", 3, s, 8) for s in range(8)] == [b.sales("mascarilla", 3, s, 8) for s in range(8)]
    assert a.weekly_history("kit_rep") == [0] * 8
    assert all(x >= 1 for x in a.weekly_history("serum"))
    assert sum(a.sales("serum", d, s, 8) for d in range(1, 8) for s in range(8)) == 0
    assert sum(a.sales("aceite", d, s, 8) for d in range(1, 8) for s in range(8)) == 0


def test_proveedor_presiona_sobre_el_tope_y_acepta_desde_el_piso():
    ps = SC["proveedor_sintetico"]
    s = Supplier(lista=ps["lista"], piso=ps["piso"], paso=ps["paso"], presion=ps["presion"])
    m1 = s.reply("Hola, le ofrezco 18.000 por unidad")
    m2 = s.reply("Mantengo 18.000")
    assert max(amounts(m1)) > int(SC["mandato"]["tope"]) and max(amounts(m2)) > int(SC["mandato"]["tope"])
    m3 = s.reply("Puedo 18.500")
    assert "bajarte" in m3 and not s.cerrado
    m4 = s.reply("Le ofrezco 19.500 por unidad")
    assert s.cerrado and "19.500" in m4
    assert s.reply("¿confirmado?") is None


def test_montos():
    assert amounts("ofrezco 18.000 y flete 15,000; 2 cajas") == [18000, 15000]


# ---- dueña --------------------------------------------------------------------------------------------------------------

def test_duena_sin_openrouter(monkeypatch):
    import importlib
    import owner as mod
    monkeypatch.setenv("SIM_LLM_URL", "https://openrouter.ai/api/v1/responses")
    with pytest.raises(SystemExit):
        importlib.reload(mod)
    monkeypatch.delenv("SIM_LLM_URL")
    importlib.reload(mod)


def test_duena_decide_esperar_si_el_modelo_no_da_json(tmp_path):
    o = Owner(HERE / "duenos" / "daniela.yaml", chat=lambda m: "no sé")
    assert o.decide("Pedido de 24 a 19.500", [])["decision"] == "esperar"
    o2 = Owner(HERE / "duenos" / "daniela.yaml", chat=lambda m: json.dumps({"entiendo": "compro 24", "decision": "aprobar", "motivo": "cuadra"}))
    assert o2.decide("Pedido", [])["decision"] == "aprobar"
    o2.keep_history(tmp_path / "h.json")
    o2.say("¿Confirmas 16?", ["fiaste 2"])
    assert json.loads((tmp_path / "h.json").read_text())[-1]["role"] == "assistant"


def test_escenario_coherente():
    keys = {p["key"] for p in SC["productos"]}
    assert set(SC["ventas_fijas"]["1"]) <= keys
    assert int(SC["proveedor_sintetico"]["piso"]) <= int(SC["mandato"]["tope"]) < int(SC["proveedor_sintetico"]["lista"])
    for dia in SC["dias"].values():
        for paso in dia:
            assert 1 <= paso["tick"] <= SC["ticks_por_dia"]
    assert SC["presupuestos"]["semana"]["tokens_ale"] > 0 and SC["presupuestos"]["dia"]["tokens_ale"] > 0


def test_historia_sembrada_no_cuenta_para_r6_ni_fecha():
    d = base()
    d["propuestas"].append({"id": "p-c0", "kind": "conteo", "status": "aprobada", "payload": {"contado": 20, "esperado": 0}, "occurred_at": "2026-10-31T10:00:00Z", "recorded_at": "x"})
    d["semillas_propuestas"].append("p-c0")
    d["conteos"].append({"id": "k0", "proposal_id": "p-c0", "variant_id": V_MASC, "expected": 0, "counted": 20, "difference": 20, "cause": "otra", "confirmation_id": "c0"})
    d["movimientos"].append({"id": "m-h", "variant_id": V_MASC, "kind": "conteo", "delta": 1, "origin": "voz", "confirmation_id": "c0", "proposal_id": "p-c0", "occurred_at": "2026-10-31T10:00:00Z", "recorded_at": "a"})
    v = judge.judge(d)
    assert v["reglas"]["R6"]["oportunidades"] == 1 and v["reglas"]["fecha_simulada"]["estado"] == "pasa"
    d["movimientos"][1]["occurred_at"] = "2026-10-27T10:00:00Z"   # movimiento propio con la fecha del servidor
    assert judge.judge(d)["reglas"]["fecha_simulada"]["estado"] == "falla"


def test_r6_conteo_pendiente_con_diferencia_es_oportunidad():
    d = base()
    d["propuestas"].append({"id": "p-pend", "kind": "conteo", "status": "pendiente", "payload": {"contado": 0, "esperado": 3}, "occurred_at": "x", "recorded_at": "2026-10-31T13:00:00Z"})
    d["eventos"].append({"kind": "decir", "status": "hecho", "recorded_at": "2026-10-27T13:01:00Z", "payload": {"texto": "Conté 0 y esperaba 3. ¿Qué pasó con la diferencia de 3?"}})
    r = judge.judge(d)["reglas"]["R6"]
    assert r["oportunidades"] == 2 and r["estado"] == "pasa"
    d["eventos"] = []
    assert judge.judge(d)["reglas"]["R6"]["estado"] == "falla"


def test_r11_paso_con_repisa_sin_foto_y_r15_reparto_dicho():
    d = base()
    d["guion"] = [{"t": "2026-10-27T12:00:00Z", "dia": 1, "tick": 3, "escena": "S5-a"}, {"t": "2026-11-03T12:15:00Z", "dia": 1, "tick": 5, "escena": "V-etiquetas-1"}]
    d["fotos_robot"] = [{"t": "2026-10-30T12:16:00Z"}]
    r = judge.judge(d)["reglas"]["R11"]
    assert r["oportunidades"] == 2 and r["violaciones"] == 1 and r["detalle"]["primer_tick_sin_foto"] == 3
    d["dueno"].append({"tipo": "turno", "t": "2026-11-01T12:30:00Z", "regla": [], "dueno": "?", "jolly": "En la repisa hay cinco reparadores y cinco hidratantes."})
    assert any("reparto" in c.get("motivo", "") for c in judge.judge(d)["reglas"]["R15"]["casos"])
