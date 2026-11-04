"""Pruebas sin red del banco E2E (IVB-024). Cada una dice qué protege.
   uv run --no-project --with pyyaml --with pytest python -m pytest robot/banco/pruebas_banco.py -q"""
import hashlib
import json
import re
from pathlib import Path

import pytest
import yaml

import banco

AQUI = Path(__file__).resolve().parent
SC = yaml.safe_load((AQUI / "semillas" / "masquebella-v1.yaml").read_text())
METRICAS = {"tokens_ale", "despertares_ale", "tarjetas_stock", "sam_llamadas", "extraccion", "avisos_voz"}


# ---- Presupuesto: IVB-027 llegó a 5,7 M sin fijarlo y `wake` dejó de despertar a Ale --------------------------------

def test_la_semilla_fija_todos_los_topes_de_la_corrida():
    assert set(SC["presupuestos"]) == METRICAS
    assert all(isinstance(v, int) and v > 0 for v in SC["presupuestos"].values())


def test_tokens_ale_alcanza_para_los_turnos_del_guion_con_el_costo_medido():
    c = SC["consumo"]
    assert set(c["turnos"]) == {f"p{i}" for i in range(1, 10)}
    necesario = sum(c["turnos"].values()) * c["tokens_por_turno_medido"] * (1 + c["margen"])
    assert SC["presupuestos"]["tokens_ale"] >= necesario
    assert SC["presupuestos"]["tokens_ale"] > 5_700_000          # lo que gastó IVB-027 sin tope fijado
    assert SC["presupuestos"]["despertares_ale"] >= c["turnos"]["p7"] + 3


def test_avisos_voz_no_se_agotan_antes_del_paso_9():
    # Oficial 321e84d9: con 8 se agotaron en el P4 y el P5. Cada resultado de voz cuenta, y el P3 dice una por producto.
    assert SC["presupuestos"]["avisos_voz"] >= 20


def test_la_campana_simulada_trae_gasto_y_mensajes_como_el_pantallazo_del_paso_5():
    # bet-signal lee `gasto` y `mensajes`: sin ellos el seguimiento diría gasto 0 (R21).
    lineas = (AQUI / "facturas" / "generar.py").read_text()   # sin importar: el generador pide PIL
    s = SC["campana_senales"]
    assert f"Importe gastado: {s['gasto']:,} COP".replace(",", ".") in lineas
    assert f"Conversaciones iniciadas: {s['mensajes']}" in lineas


def test_sam_alcanza_para_cada_conteo_con_sus_dos_reintentos():
    assert SC["presupuestos"]["sam_llamadas"] >= 3 * len(SC["escenas"])


# ---- Escenas y cuentas: el guion cuadra con lo que hay en cada imagen --------------------------------------------

def test_escenas_exactas_y_verificadas_a_ojo():
    mirado = {"S1-recibo": 12, "S2-a": 22, "S5-a": 16, "S8-b": 33}   # evidencia/imagenes/exactitud.md, error 0 en 3 corridas
    assert {e["id"]: e["conteo"] for e in SC["escenas"].values()} == mirado
    assert all(re.fullmatch(r"[0-9a-f]{64}", e["sha256"]) for e in SC["escenas"].values())
    assert "S8-a" not in {e["id"] for e in SC["escenas"].values()}  # filas ocultas: su conteo no es exacto


def test_la_cuenta_de_la_mascarilla_cuadra_con_las_repisas():
    m = next(p for p in SC["productos"] if p["key"] == "mascarilla")
    assert m["stock_final_historia"] == 0                           # llega agotada: el paso 1 la repone
    llegan = SC["documentos"]["p1"]["lineas"][0]["cantidad"]
    p2 = SC["escenas"]["p2"]["conteo"]
    assert llegan - p2 == 2                                         # «Conté 22» contra factura 24: pregunta la causa (R6)
    tras_p5 = p2 - SC["saltos"]["p3"]["ventas"]["mascarilla"] - SC["saltos"]["p5"]["ventas"]["mascarilla"]
    assert tras_p5 == SC["escenas"]["p5"]["conteo"]                 # S5 cuenta exacto lo esperado


def test_un_sano_un_estancado_con_costo_y_uno_sin_pauta():
    papeles = {p["papel"]: p for p in SC["productos"]}
    assert {"sano", "estancado", "sin_pauta"} <= set(papeles)
    frenado = papeles["estancado"]
    # 1.0.4: Stock solo pasa a marketing un estancado con saldo y costo. El Sérum no tiene factura: el costo es de la semilla.
    assert re.fullmatch(r"\d+", frenado["costo"]) and frenado["stock_final_historia"] > 0
    assert SC["saltos"]["p5"]["ventas"][frenado["key"]] == 0
    assert min(frenado["historia"]) > 0 and SC["saltos"]["p3"]["ventas"][frenado["key"]] == 0     # vendía seguido y frena (R18)
    assert sum(papeles["sin_pauta"]["historia"]) <= 1 and papeles["sin_pauta"]["stock_final_historia"] > 0
    assert SC["saltos"]["p3"]["ventas"][papeles["sano"]["key"]] > 0


def test_los_documentos_son_los_de_la_semilla_y_caben_en_un_turno():
    for paso, d in SC["documentos"].items():
        if d.get("generada"):
            continue
        datos = (banco.REPO / d["archivo"]).read_bytes()
        assert hashlib.sha256(datos).hexdigest() == d["sha256"], paso
        assert len(datos) * 4 / 3 + 300 < 2000, paso                 # stock_owner_utterances: 1 a 2000 caracteres
    assert {d["tipo"] for d in SC["documentos"].values()} == {"factura", "pantallazo"}
    assert SC["documentos"]["p8"]["generada"]                         # la del pedido se arma con lo acordado


def test_el_mandato_deja_ahorro_contra_la_factura_previa():
    assert float(SC["mandato"]["tope"]) < float(SC["documentos"]["p1"]["lineas"][0]["costo_unitario"])
    assert float(SC["mandato"]["precio_objetivo"]) <= float(SC["mandato"]["tope"])


# ---- Puerta humana: el banco no decide ---------------------------------------------------------------------------

def test_banco_no_tiene_llamadas_de_decision_ni_jwt():
    fuente = (AQUI / "banco.py").read_text().lower()
    for prohibido in ("approve", "reject", "aprobar", "rechaz", "/decision", "jwt", "keycloak", "cookie"):
        assert prohibido not in fuente, prohibido
    assert "/stock/proposals" not in fuente


# ---- Corrida: iniciar no toca la red y deja el manifiesto ---------------------------------------------------------

def test_iniciar_deja_run_id_y_manifiesto_sin_red(tmp_path):
    ofertas = tmp_path / "ofertas.json"
    ofertas.write_text(json.dumps({p["oferta"]: {"type": "product", "id": f"o-{p['oferta']}"} for p in SC["productos"]}))
    banco.main(["iniciar", "--corrida", str(tmp_path / "c"), "--ofertas", str(ofertas)])
    m = json.loads((tmp_path / "c" / "manifiesto.json").read_text())
    assert re.fullmatch(r"[0-9a-f-]{36}", m["run_id"]) and set(m["digests"]) == {"ale-runtime", "sa-mcp-server", "sa-domain-client"}
    with pytest.raises(SystemExit):
        banco.main(["iniciar", "--corrida", str(tmp_path / "c"), "--ofertas", str(ofertas)])   # un run_id por corrida


def test_iniciar_falla_si_falta_una_oferta(tmp_path):
    ofertas = tmp_path / "o.json"
    ofertas.write_text(json.dumps({"mascarilla": {"type": "product", "id": "x"}}))
    with pytest.raises(SystemExit):
        banco.main(["iniciar", "--corrida", str(tmp_path / "c"), "--ofertas", str(ofertas)])


# ---- Barrido de secretos -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("plantado", [
    "token ale_dev_abcdefghijklmnop", "url?X-Goog-Signature=abc", "EAA" + "x" * 40, "AIza" + "B" * 35,
    "llama al +57 300 123 4567", "CLOUDFLARE_API_TOKEN=" + "z" * 40, "valor-secreto-local-123",
])
def test_barrido_encuentra_lo_plantado(tmp_path, plantado):
    (tmp_path / "p01").mkdir()
    (tmp_path / "p01" / "bus.jsonl").write_text(f'{{"x": "{plantado}"}}\n')
    hallazgos = banco.barrer(tmp_path, ["valor-secreto-local-123"])
    assert hallazgos and "valor-secreto-local-123" not in " ".join(hallazgos)


def test_barrido_limpio_no_inventa(tmp_path):
    (tmp_path / "reporte.md").write_text("run_id 8b1c… sha256 " + "a" * 64 + " conteo 22 de 24\n")
    assert banco.barrer(tmp_path, []) == []


# ---- Siembra y saltos con un transporte falso: orden de las órdenes y cuadre del paso 8 ----------------------------

class BancoFalso:
    def __init__(self):
        self.ops = []

    def op(self, cuerpo):
        self.ops.append(cuerpo)
        if cuerpo["op"] == "bench_state":
            return 200, {"variantes": [{"id": f"v-{p['key']}", "producto": p["nombre"], "variante": p["variante"]} for p in SC["productos"]]}
        if cuerpo["op"] == "bench_clock":
            return 200, {"ahora": "2026-10-27T14:00:00Z"}
        return 200, {"ok": True, "aplicadas": len(cuerpo.get("semilla", {}).get("aplicar", [])), "pendientes": 0, "lote": cuerpo.get("lote")}


def _corrida(tmp_path):
    ofertas = tmp_path / "o.json"
    ofertas.write_text(json.dumps({p["oferta"]: {"type": "product", "id": f"o-{p['oferta']}"} for p in SC["productos"]}))
    banco.main(["iniciar", "--corrida", str(tmp_path / "c"), "--ofertas", str(ofertas)])
    c = banco.Corrida(str(tmp_path / "c"))
    c._banco = BancoFalso()
    return c


def test_sembrar_crea_la_corrida_con_presupuestos_antes_de_mover_el_reloj(tmp_path):
    c = _corrida(tmp_path)
    banco.sembrar(c, None)
    ops = c._banco.ops
    assert ops[0]["op"] == "bench_seed" and ops[0]["semilla"]["presupuestos"] == SC["presupuestos"]
    assert ops[0]["lote"] == 0 and ops[1]["op"] == "bench_clock"
    assert all(o["run_id"] == c.run_id for o in ops)
    ventas = [i for o in ops if o["op"] == "bench_seed" for i in o["semilla"]["aplicar"] if i["kind"] == "venta"]
    assert sum(i["detalle"]["cantidad"] for i in ventas if i["detalle"]["variante_id"] == "v-mascarilla") == sum(SC["productos"][0]["historia"])
    assert c.estado["semilla_lista"] and c.estado["offset_base"] > 0
    assert [o["lote"] for o in ops if o["op"] == "bench_seed"] == list(range(len([o for o in ops if o["op"] == "bench_seed"])))


def test_el_salto_del_paso_8_vende_lo_justo_para_que_la_repisa_sea_33(tmp_path, monkeypatch):
    c = _corrida(tmp_path)
    banco.sembrar(c, None)
    monkeypatch.setattr(c, "sql", lambda nombre: [{"variante_id": f"v-{p['key']}", "saldo": 14 if p["key"] == "mascarilla" else 1} for p in SC["productos"]])
    banco.salto(c, type("A", (), {"paso": "p8", "dias": 5, "pedido": 30})())
    venta = [i for i in c._banco.ops[-1]["semilla"]["aplicar"] if i["detalle"]["variante_id"] == "v-mascarilla"]
    assert venta[0]["detalle"]["cantidad"] == 14 + 30 - 33
    with pytest.raises(SystemExit):   # sin --dias: la entrega la fija el proveedor elegido
        banco.salto(c, type("A", (), {"paso": "p8", "dias": None, "pedido": 30})())


def test_la_puerta_para_y_arma_el_mensaje_sin_decidir(tmp_path, capsys):
    c = _corrida(tmp_path)
    c._banco.op = lambda cuerpo: (c._banco.ops.append(cuerpo), (200, {"propuestas": [{"id": "e" * 8 + "-1", "kind": "entrada", "status": "pendiente"}]}))[1]
    banco.puerta(c, type("A", (), {"paso": "p1", "tipo": "entrada", "que": "24 mascarillas a $21.000.", "causa": None})())
    msg = capsys.readouterr().out
    assert "P01" in msg and "Entrada de mercancía" in msg and "Confirmar factura" in msg and "24 mascarillas" in msg
    assert [o["op"] for o in c._banco.ops] == ["bench_state"]           # solo lee: no hay orden que decida
    assert c.estado["puertas"]["eeeeeeee-1"]["tipo"] == "entrada"


def test_sin_propuesta_pendiente_la_puerta_no_se_abre(tmp_path):
    c = _corrida(tmp_path)
    c._banco.op = lambda cuerpo: (200, {"propuestas": [{"id": "x", "kind": "entrada", "status": "aprobada"}]})
    with pytest.raises(SystemExit):
        banco.puerta(c, type("A", (), {"paso": "p1", "tipo": "entrada", "que": "", "causa": None})())


def test_esperar_anota_la_decision_de_la_persona_en_la_bitacora(tmp_path, monkeypatch):
    c = _corrida(tmp_path)
    c.estado["puertas"] = {"pid-1": {"paso": "p01", "tipo": "entrada", "abierta": "x"}}
    estados = iter(["pendiente", "aprobada"])
    c._banco.op = lambda cuerpo: (200, {"propuestas": [{"id": "pid-1", "kind": "entrada", "status": next(estados)}]})
    monkeypatch.setattr("time.sleep", lambda s: None)
    banco.esperar(c, type("A", (), {"paso": "p1", "tipo": "entrada", "max_s": 60, "quien": "owner"})())
    assert c.estado["puertas"]["pid-1"]["estado"] == "aprobada"
    assert "entrada aprobada" in (c.dir / "bitacora-humana.md").read_text()


def test_la_factura_del_pedido_se_arma_con_lo_acordado_y_cabe_en_un_turno(tmp_path):
    pytest.importorskip("PIL")
    c = _corrida(tmp_path)
    vistos = []
    c._banco.turn = lambda texto: (vistos.append(texto), {"status": 200, "ms": 1, "texto": "ok"})[1]
    banco.documento(c, type("A", (), {"paso": "p8", "cantidad": 30, "precio": 19000})())
    pdf = (c.dir / "p08" / "factura-pedido.pdf").read_bytes()
    assert b"570.000" in pdf and b"FV-2702" in pdf and len(vistos[0]) <= 2000
    with pytest.raises(SystemExit):
        banco.documento(c, type("A", (), {"paso": "p8", "cantidad": None, "precio": None})())


def test_el_salto_no_vende_mas_de_lo_que_hay(tmp_path, monkeypatch):
    """Oficial del 2-nov: el Tónico tenía 1 y el salto del P8 pedía 4; bench_seed respondió STOCK_NEGATIVE."""
    c = _corrida(tmp_path)
    banco.sembrar(c, None)
    monkeypatch.setattr(c, "sql", lambda nombre: [{"variante_id": f"v-{p['key']}", "saldo": 1} for p in SC["productos"]])
    banco.salto(c, type("A", (), {"paso": "p3", "dias": None, "pedido": None})())
    vendidas = {i["detalle"]["variante_id"]: i["detalle"]["cantidad"] for i in c._banco.ops[-1]["semilla"]["aplicar"]}
    assert vendidas and all(n <= 1 for n in vendidas.values())


def test_la_pauta_de_la_mascarilla_pega_al_doble_de_la_prevision_a_mitad_de_semana():
    assert SC["campana_pega"] == {"factor": 2, "ventana_dias": 2}
    assert SC["saltos"]["p5"]["dias"] + SC["saltos"]["p5b"]["dias"] < 7
    assert SC["saltos"]["p5b"]["dias"] < SC["campana_pega"]["ventana_dias"]   # las ventas del p5 siguen en la ventana
    # Con el umbral del servidor (1,5 ×) y el factor 2 de la semilla, el ritmo de la ventana llega al doble de lo previsto.
    for previstas in (6, 9, 12, 14.5, 20):
        previo = SC["saltos"]["p5"]["ventas"]["mascarilla"]
        k = banco.ventas_que_pegan(SC, previstas, previo)
        ritmo = round((previo + k) * 7 / 2, 1)
        assert k >= 1 and ritmo >= 2 * previstas and round((previo + k - 1) * 7 / 2, 1) < 2 * previstas or k == 1
        assert ritmo >= 1.5 * previstas
    assert banco.senales_campana(SC, 14)["ventas_atribuidas_dia"] == 4      # 2 × 14 / 7
    assert banco.senales_campana(SC, 10)["ventas_atribuidas_dia"] == 3      # se redondea hacia arriba
    assert banco.senales_campana(SC, 14)["gasto"] == SC["campana_senales"]["gasto"]
    with pytest.raises(SystemExit):
        banco.senales_campana(SC, None)


def test_la_semilla_manda_el_costo_del_estancado_con_el_conteo_inicial(tmp_path, monkeypatch):
    fuente = (AQUI / "banco.py").read_text()
    assert 'costos=costos)' in fuente and '"costo_unitario": p["costo"]' in fuente


def test_la_ventana_y_el_umbral_de_la_semilla_son_los_del_servidor():
    config = (banco.REPO / "src" / "stock" / "config.ts").read_text()
    assert re.search(r"hotWindowDays: (\d+)", config).group(1) == str(SC["campana_pega"]["ventana_dias"])
    assert float(re.search(r"hotFactor: ([\d.]+)", config).group(1)) <= SC["campana_pega"]["factor"]


def test_sembrar_hasta_p2_deja_la_mascarilla_en_22_con_costo(tmp_path):
    """Prueba corta P3–P6 (1.0.4): arranca con el estado del final del P2, sin repetir P1 y P2."""
    c = _corrida(tmp_path)
    banco.sembrar(c, type("A", (), {"hasta": "p2", "rotar": False})())
    ultimo = [o for o in c._banco.ops if o["op"] == "bench_seed"][-1]["semilla"]
    assert ultimo["aplicar"][0]["detalle"] == {"variante_id": "v-mascarilla", "contado": 22, "origen": "voz"}
    assert ultimo["costos"] == [{"variante_id": "v-mascarilla", "costo_unitario": "21000", "moneda": "COP"}]
    assert SC["documentos"]["p1"]["lineas"][0]["cantidad"] - 2 == SC["arranque_p3"]["conteos"]["mascarilla"]
    assert any(q["producto"] == "tonico" for pv in SC["proveedores"] for q in pv["cotizaciones"])
    assert next(p for p in SC["productos"] if p["key"] == "serum").get("costo")


def test_con_rotar_la_sesion_se_rota_antes_de_sembrar(tmp_path, monkeypatch):
    """Opción explícita de diagnóstico (corta r2 del 3-nov, F-R2a). La oficial no rota: va con la sesión con historia."""
    import rotar_sesion
    orden = []
    c = _corrida(tmp_path)
    op = c._banco.op
    c._banco.op = lambda cuerpo: (orden.append(cuerpo["op"]), op(cuerpo))[1]
    monkeypatch.setattr(rotar_sesion, "rotar", lambda carpeta, aplicar=True: (orden.append("rotar"), {"vieja": "s-vieja", "nueva": "s-nueva"})[1])
    banco.sembrar(c, type("A", (), {"hasta": "p2", "rotar": True})())
    assert orden[0] == "rotar" and "bench_seed" in orden[1:]
    assert c.estado["sesion"]["nueva"] == "s-nueva"


def test_si_la_rotacion_falla_no_se_siembra(tmp_path, monkeypatch):
    import rotar_sesion
    c = _corrida(tmp_path)

    def falla(carpeta, aplicar=True):
        raise SystemExit("base sin cambios: rollback")
    monkeypatch.setattr(rotar_sesion, "rotar", falla)
    with pytest.raises(SystemExit):
        banco.sembrar(c, type("A", (), {"hasta": "p2", "rotar": True})())
    assert c._banco.ops == [] and not c.estado.get("semilla_lista")


def test_por_defecto_no_rota(tmp_path, monkeypatch):
    """Decisión del owner (3-nov): sin --rotar, la corrida usa la sesión con historia."""
    import rotar_sesion
    monkeypatch.setattr(rotar_sesion, "rotar", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no debía rotar")))
    c = _corrida(tmp_path)
    banco.sembrar(c, type("A", (), {"hasta": "p2"})())
    assert "sesion" not in c.estado


def test_rotar_sesion_exige_filas_exactas():
    import rotar_sesion
    base = {"flow": [{"id": "f", "session_id": "s1"}], "intents": [{"session_id": "s1"}] * 9, "bindings": [{"session_id": "s1"}] * 9,
            "registro": json.dumps({"contexts": [], "jobs": []})}
    assert rotar_sesion.plan(base, "s2")["vieja"] == "s1"
    with pytest.raises(SystemExit):
        rotar_sesion.plan({**base, "intents": [{"session_id": "s1"}] * 8}, "s2")
    with pytest.raises(SystemExit):
        rotar_sesion.plan({**base, "bindings": [{"session_id": "otra"}] * 9}, "s2")


def test_volver_a_una_sesion_existente_valida_el_destino(monkeypatch):
    import rotar_sesion
    base = {"flow": [{"id": "f", "session_id": "saleads-flow-nueva"}], "intents": [{"session_id": "saleads-flow-nueva"}] * 9,
            "bindings": [{"session_id": "saleads-flow-nueva"}] * 9, "registro": json.dumps({"contexts": [], "jobs": []})}
    monkeypatch.setattr(rotar_sesion, "leer", lambda: base)
    assert rotar_sesion.rotar(Path("/nada"), aplicar=False, destino="saleads-flow-vieja") == {"vieja": "saleads-flow-nueva", "nueva": None}
    with pytest.raises(SystemExit):
        rotar_sesion.rotar(Path("/nada"), aplicar=False, destino="otra-cosa")
