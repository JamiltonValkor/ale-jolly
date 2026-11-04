"""Pruebas de `ojo`. Cada una nombra la regla que garantiza. SAM va con respuestas reales grabadas, sin red.
   python -m pytest pruebas_ojo.py -q"""
import hashlib, io, json, os, re, signal, socket, subprocess, sys, threading, time, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import zmq
from PIL import Image

import camara, numerar, ojo as modulo, sam
from bus_ojo import BusOjo
from ojo import Nube, Ojo, limpiar, reducir

AQUI = Path(__file__).parent
FIJOS = AQUI.parent / "banco" / "fixtures"
MANIFIESTO = AQUI / "pruebas" / "manifiesto-minimo.json"
SID = "00000000-0000-4000-8000-00000000000"


def caja(x, y, w=10, h=10, c=0.9):
    return {"caja": [x, y, x + w, y + h], "confianza": c}


class BusFalso:
    def __init__(self):
        self.mensajes = []

    def publicar(self, tema, **d):
        self.mensajes.append((tema, d))

    def estados(self, s):
        return [d["estado"] for t, d in self.mensajes if t == "ojo/estado" and d["solicitud_id"] == s]


class NubeFalsa:
    def __init__(self, falla_subida=False):
        self.ops, self.subidas, self.falla = [], [], falla_subida

    def op(self, cuerpo):
        self.ops.append(cuerpo)
        return {}

    def subir(self, rol, solicitud, datos):
        if self.falla:
            raise urllib.error.URLError("sin red")
        self.subidas.append((rol, solicitud, len(datos)))

    def clave_meta(self):
        return "clave"


class CamaraFalsa:
    def __init__(self):
        self.n = 0

    def capturar(self):
        self.n += 1
        salida = io.BytesIO()
        Image.new("RGB", (2000, 1000), (200, 180, 160)).save(salida, "JPEG")
        return camara.Captura(salida.getvalue(), "simulada", "d" * 64)


def _ojo(tmp_path, contar=None, nube=None, cam=None):
    bus, nube, cam = BusFalso(), nube or NubeFalsa(), cam or CamaraFalsa()
    return Ojo(bus, nube, cam, tmp_path, contar=contar or (lambda *a: {"objetos": [caja(20, 20), caja(50, 20)], "ms": 5})), bus, nube, cam


# ---- Parser: formato real ---------------------------------------------------------------------------------------

def test_parser_con_respuesta_real_grabada_da_las_nueve_cajas_sin_mascaras():
    with open(FIJOS / "sam-jar.sse", "rb") as f:
        objetos = sam.parsear(sam.leer_stream(f))
    assert len(objetos) == 9
    assert all(set(o) == {"id", "caja", "confianza"} for o in objetos)
    assert all(0.5 < o["confianza"] <= 1 and o["caja"][2] > o["caja"][0] for o in objetos)


def test_el_fixture_de_sam_esta_en_las_coordenadas_de_lo_que_ojo_envia():
    """El humo de la Pi (2-nov) dibujó los discos corridos: `sam-jar.sse` venía de la imagen original de 2016 px y `ojo`
    manda a SAM la reducida a 1600. Cada registro declara `w`/`h` de la imagen que vio SAM: deben ser los de `reducir`,
    y ninguna caja puede salirse de ella."""
    with Image.open(io.BytesIO(modulo.reducir((FIJOS / "frascos-9.jpg").read_bytes()))) as enviada:
        ancho, alto = enviada.size
    with open(FIJOS / "sam-jar.sse", "rb") as f:
        texto = sam.leer_stream(f)
    declarados = {(int(w), int(h)) for w, h in re.findall(r"<\|box;[^|]*?w=(\d+);h=(\d+)", texto)}
    assert declarados == {(ancho, alto)}
    for o in sam.parsear(texto):
        x1, y1, x2, y2 = o["caja"]
        assert 0 <= x1 < x2 <= ancho and 0 <= y1 < y2 <= alto


def test_lane_vacio_real_es_cero_y_no_error():
    with open(FIJOS / "sam-vacio.sse", "rb") as f:
        assert sam.parsear(sam.leer_stream(f)) == []


def test_un_stream_cortado_no_pasa_por_cero():
    with pytest.raises(sam.ErrorSam):
        sam.leer_stream(["event: response.created\n", 'data: {"type":"response.created"}\n'])


def test_campos_por_clave_no_por_posicion():
    texto = "<0f>0<|box;c=0.8;x2=30;x1=10;y1=5;y2=25;w=1;h=1|><|mask;x=0;y=0;data=1,1,!x|>,2<|box;x1=1;y1=1;x2=2;y2=2;w=1;h=1|><|mask;x=0|>"
    assert sam.parsear(texto) == [{"id": 0, "caja": [10.0, 5.0, 30.0, 25.0], "confianza": 0.8}, {"id": 2, "caja": [1.0, 1.0, 2.0, 2.0], "confianza": None}]


def test_la_peticion_pide_stream_y_mascara_chica():
    c = sam.cuerpo(b"x", "jar")
    assert c["stream"] is True and c["model"] == "sam-3.1"
    assert c["metadata"] == {"include_confidence": "true", "mask_encoding": "one_bit"}


def test_red_caida_sale_con_error_tras_un_reintento_sin_colgarse():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        puerto = s.getsockname()[1]
    t0 = time.monotonic()
    with pytest.raises(sam.ErrorSam):
        sam.contar(b"x", "jar", "k", url=f"http://127.0.0.1:{puerto}/", tiempo_s=1, espera_s=0.01)
    assert time.monotonic() - t0 < 5


def test_el_error_de_sam_no_contiene_la_clave():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        puerto = s.getsockname()[1]
    with pytest.raises(sam.ErrorSam) as e:
        sam.contar(b"x", "jar", "CLAVE-SECRETA", url=f"http://127.0.0.1:{puerto}/", espera_s=0)
    assert "CLAVE-SECRETA" not in str(e.value)


# ---- Numerar ------------------------------------------------------------------------------------------------------

def test_orden_de_lectura_a_mano_fila_de_atras_primero():
    atras = [caja(x, 10 + (x % 3), 10, 20) for x in (70, 10, 50, 30, 150, 90, 130, 110)]      # 8 desordenadas
    frente = [caja(40, 60, 10, 20), caja(10, 62, 10, 20)]
    orden = numerar.ordenar(frente + atras)
    assert [o["n"] for o in orden] == list(range(1, 11))
    assert [o["caja"][0] for o in orden] == [10, 30, 50, 70, 90, 110, 130, 150, 10, 40]


def test_confianza_baja_no_cuenta_y_sin_dato_si():
    assert len(numerar.filtrar([caja(0, 0, c=0.49), caja(20, 0, c=0.5), caja(40, 0, c=None)], 0.5)) == 2


def test_cajas_casi_identicas_cuentan_una():
    assert len(numerar.filtrar([caja(0, 0, 100, 100, 0.9), caja(1, 1, 100, 100, 0.8), caja(0, 0, 100, 40, 0.8)], 0.5)) == 2


def test_dibuja_contra_el_tamano_pedido_y_recorta_a_las_cajas():
    foto = Image.new("RGB", (1600, 900), (0, 0, 200))
    for tam in ((480, 320), (1280, 720), (960, 640)):
        assert numerar.dibujar(foto, numerar.ordenar([caja(100, 100, 50, 50)]), "frascos", tam).size == tam
    assert numerar._recorte([caja(100, 100, 50, 50)], foto.size)[2] < 200


def test_mas_de_40_son_puntos_sin_numero(monkeypatch):
    llamados = []
    real = numerar.ImageDraw.ImageDraw.text
    monkeypatch.setattr(numerar.ImageDraw.ImageDraw, "text", lambda self, xy, t, **k: (llamados.append(t), real(self, xy, t, **k))[1])
    objetos = numerar.ordenar([caja(10 + i * 15, 10) for i in range(41)])
    numerar.dibujar(Image.new("RGB", (800, 100)), objetos, "frascos", (1280, 720))
    assert llamados == ["Conté 41 frascos"]
    llamados.clear()
    numerar.dibujar(Image.new("RGB", (800, 100)), objetos[:40], "frascos", (1280, 720))
    assert len(llamados) == 41


# ---- Fuentes ------------------------------------------------------------------------------------------------------

def test_produccion_niega_las_fuentes_simuladas():
    for spec in ("carpeta:/x.json", "muse:/x.json"):
        with pytest.raises(SystemExit, match="produccion"):
            camara.abrir(spec, entorno="produccion")
    assert isinstance(camara.abrir("carpeta:/x.json", entorno="dev"), camara.Carpeta)


def test_carpeta_marca_simulada_con_el_sha_del_manifiesto():
    c = camara.abrir(f"carpeta:{MANIFIESTO}", entorno="").capturar()
    e = json.loads(MANIFIESTO.read_text())["imagenes"][0]
    assert (c.fuente, c.sha256) == ("simulada", e["sha256"]) and hashlib.sha256(c.datos).hexdigest() == e["sha256"]


def test_carpeta_rechaza_una_imagen_que_no_coincide(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"otra cosa")
    m = tmp_path / "m.json"
    m.write_text(json.dumps({"imagenes": [{"id": "a", "archivo": "a.jpg", "sha256": "0" * 64}]}))
    with pytest.raises(camara.ErrorCamara, match="sha256"):
        camara.Carpeta(str(m)).capturar()


def test_escena_actual_elige_la_imagen(tmp_path, monkeypatch):
    monkeypatch.delenv("ALE_ESCENA", raising=False)
    for n in "ab":
        (tmp_path / f"{n}.jpg").write_bytes(n.encode())
    m = tmp_path / "m.json"
    m.write_text(json.dumps({"imagenes": [{"id": n, "archivo": f"{n}.jpg", "sha256": hashlib.sha256(n.encode()).hexdigest()} for n in "ab"]}))
    (tmp_path / "escena_actual").write_text("b\n")
    assert camara.Carpeta(str(m)).capturar().datos == b"b"
    monkeypatch.setenv("ALE_ESCENA", "z")
    with pytest.raises(camara.ErrorCamara):
        camara.Carpeta(str(m)).capturar()


class MuseFalso:
    def __init__(self):
        self.pedidos = []
        sim = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                sim.pedidos.append((json.loads(self.rfile.read(int(self.headers["Content-Length"]))), self.headers["Authorization"], self.headers["User-Agent"]))
                b = json.dumps({"data": [{"b64_json": "aG9sYQ=="}]}).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/"


def test_muse_entra_como_lectura_de_camara_simulada_y_no_paga_dos_veces(tmp_path):
    sim = MuseFalso()
    m = tmp_path / "e.json"
    m.write_text(json.dumps({"escenas": [{"id": "s", "prompt": "frascos en un estante"}]}))
    muse = camara.Muse(str(m), lambda: "clave", tmp_path / "cache", url=sim.url)
    a, b = muse.capturar(), muse.capturar()
    assert (a.fuente, a.datos) == ("simulada", b"hola") and a.sha256 == b.sha256
    assert len(sim.pedidos) == 1
    cuerpo, auth, agente = sim.pedidos[0]
    assert cuerpo["model"] == "muse-image-1.0" and auth == "Bearer clave" and "urllib" not in agente.lower()


# ---- Flujo --------------------------------------------------------------------------------------------------------

def test_flujo_completo_deja_salidas_sube_y_termina(tmp_path):
    o, bus, nube, cam = _ojo(tmp_path)
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "frascos", "foto_id": None})
    assert bus.estados(SID + "1") == ["capturando", "contando", "subida"]
    assert [s[0] for s in nube.subidas] == ["original", "numerada"]
    fin = nube.ops[-1]
    assert fin["op"] == "photo_done" and fin["sam"]["total"] == 2 and fin["fuente"] == "simulada" and fin["imagen_sha256"] == "d" * 64
    assert [o2["n"] for o2 in fin["sam"]["objetos"]] == [1, 2]
    conteo = next(d for t, d in bus.mensajes if t == "ojo/conteo")
    assert Path(conteo["ruta_pantalla"]).exists() and conteo["total"] == 2
    assert (Image.open(conteo["ruta_pantalla"]).size) == (1280, 720)


def test_las_cajas_van_en_coordenadas_de_la_imagen_enviada_a_sam(tmp_path):
    enviadas = []
    o, _, nube, _ = _ojo(tmp_path, contar=lambda img, *a: (enviadas.append(img), {"objetos": [caja(100, 100)], "ms": 1})[1])
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    assert Image.open(io.BytesIO(enviadas[0])).size == (1600, 800)
    assert nube.ops[-1]["sam"]["objetos"][0]["caja"] == [100, 100, 110, 110]


def test_cero_resultados_no_es_error_y_stock_decide(tmp_path):
    o, bus, nube, _ = _ojo(tmp_path, contar=lambda *a: {"objetos": [], "ms": 1})
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    assert nube.ops[-1]["op"] == "photo_done" and nube.ops[-1]["sam"]["total"] == 0
    assert "error" not in bus.estados(SID + "1")


def test_reintento_con_foto_id_no_captura_y_conserva_el_sha(tmp_path):
    o, _, nube, cam = _ojo(tmp_path)
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    o.atender({"solicitud_id": SID + "2", "concepto": "lid", "etiqueta": "f", "foto_id": SID + "1"})
    assert cam.n == 1
    assert nube.ops[-1]["imagen_sha256"] == "d" * 64 and nube.ops[-1]["sam"]["concepto"] == "lid"
    assert [s[0] for s in nube.subidas] == ["original", "numerada", "numerada"]


def test_reintento_sin_original_falla_sin_capturar(tmp_path):
    o, _, nube, cam = _ojo(tmp_path)
    o.atender({"solicitud_id": SID + "2", "concepto": "lid", "etiqueta": "f", "foto_id": SID + "1"})
    assert cam.n == 0
    assert nube.ops == [{"op": "photo_failed", "request_id": SID + "2", "motivo": "sin_original"}]


@pytest.mark.parametrize("motivo,falla", [("camara", camara.ErrorCamara("x")), ("sam", sam.ErrorSam("x"))])
def test_cada_fallo_reporta_su_motivo(tmp_path, motivo, falla):
    def rompe(*a):
        raise falla
    o, bus, nube, cam = _ojo(tmp_path, contar=rompe if motivo == "sam" else None)
    if motivo == "camara":
        cam.capturar = rompe
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    assert nube.ops == [{"op": "photo_failed", "request_id": SID + "1", "motivo": motivo}]
    assert bus.estados(SID + "1")[-1] == "error"


def test_fallo_al_subir_reporta_subida(tmp_path):
    o, _, nube, _ = _ojo(tmp_path, nube=NubeFalsa(falla_subida=True))
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    assert nube.ops[-1]["motivo"] == "subida"


def test_una_foto_a_la_vez_la_segunda_hace_cola_y_una_reentrega_no_captura(tmp_path):
    o, bus, nube, cam = _ojo(tmp_path)
    o.orden({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f"})
    o.orden({"solicitud_id": SID + "2", "concepto": "jar", "etiqueta": "f"})
    o.orden({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f"})    # reentrega
    assert o.cola.qsize() == 2 and bus.estados(SID + "1") == ["recibida", "recibida"]
    assert cam.n == 0
    while not o.cola.empty():
        o.atender(o.cola.get())
    assert cam.n == 2 and sum(1 for op in nube.ops if op["op"] == "photo_done") == 2


def test_republica_hasta_expira_y_luego_calla(tmp_path):
    ahora = [100.0]
    o, bus, _, _ = _ojo(tmp_path)
    o.reloj = lambda: ahora[0]
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    cuenta = lambda: sum(1 for t, _ in bus.mensajes if t == "ojo/conteo")
    antes = cuenta()
    o.republicar()
    assert cuenta() == antes + 1
    ahora[0] += modulo.PANTALLA_S + 1
    o.republicar()
    assert cuenta() == antes + 1


def test_token_se_lee_del_env_en_cada_subida(tmp_path):
    env = tmp_path / ".env"
    vistos = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            vistos.append((self.headers["Authorization"], self.headers["User-Agent"]))
            self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env.write_text(f"ALE_RUNTIME_URL=http://127.0.0.1:{srv.server_address[1]}\nALE_DEVICE_TOKEN=uno\n")
    nube = Nube(env)
    nube.op({"op": "state"})
    env.write_text(env.read_text().replace("uno", "dos"))
    nube.op({"op": "state"})
    assert [a for a, _ in vistos] == ["Bearer uno", "Bearer dos"]
    assert "urllib" not in vistos[0][1].lower()


# ---- Subida con la red mala (Pi despierta: el audio a Muse ahoga el hotspot) -------------------------------------

class Almacen:
    """Servidor de dev + bucket en uno: `photo_url` firma una URL hacia sí mismo y el PUT sigue un guion por intento:
    un número es un código HTTP, "colgar" no responde nunca y "lento" lee el cuerpo a ~`bps` B/s."""

    def __init__(self, guion_put=(), guion_op=(), bps=None):
        self.guion_put, self.guion_op, self.bps = list(guion_put), list(guion_op), bps
        self.firmas, self.puts, self.ops = 0, [], []
        alm = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _responder(self, codigo, cuerpo=b"{}"):
                self.send_response(codigo); self.send_header("Content-Length", str(len(cuerpo))); self.end_headers(); self.wfile.write(cuerpo)

            def do_POST(self):
                cuerpo = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                alm.ops.append(cuerpo["op"])
                paso = alm.guion_op.pop(0) if alm.guion_op else 200
                if paso != 200:
                    return self._responder(paso)
                if cuerpo["op"] == "photo_url":
                    alm.firmas += 1
                    url = f"http://127.0.0.1:{alm.srv.server_address[1]}/bucket/{cuerpo['role']}?firma=s{alm.firmas}"
                    return self._responder(200, json.dumps({"url": url, "content_type": cuerpo["content_type"]}).encode())
                self._responder(200)

            def do_PUT(self):
                paso = alm.guion_put.pop(0) if alm.guion_put else 200
                n = int(self.headers["Content-Length"])
                if paso == "colgar":
                    time.sleep(3)
                    return
                if paso == "lento":
                    leidos = 0
                    while leidos < n:
                        leidos += len(self.rfile.read(min(4096, n - leidos)))
                        time.sleep(4096 / alm.bps)
                else:
                    self.rfile.read(n)
                alm.puts.append((self.path, n, paso))
                self._responder(paso if isinstance(paso, int) else 200, b"")

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def nube(self, tmp_path, plazo_s=60):
        env = tmp_path / ".env"
        env.write_text(f"ALE_RUNTIME_URL=http://127.0.0.1:{self.srv.server_address[1]}\nALE_DEVICE_TOKEN=t\n")
        esperas = []
        n = Nube(env, plazo_s=plazo_s, dormir=esperas.append)
        n.esperas = esperas
        return n


def test_tiempo_de_espera_crece_con_el_tamano_y_nunca_baja_del_minimo():
    assert modulo.tiempo_para(1_000) == modulo.TIEMPO_MIN_S
    assert modulo.tiempo_para(200_000) == pytest.approx(10 + 200_000 / modulo.PISO_BPS)
    assert modulo.tiempo_para(400_000) > modulo.tiempo_para(200_000)


def test_subida_reintenta_ante_5xx_y_corte_y_firma_de_nuevo_cada_vez(tmp_path):
    alm = Almacen(guion_put=[503, 500, 200])
    nube = alm.nube(tmp_path)
    nube.subir("original", SID + "1", b"x" * 200_000)
    assert [c for _, _, c in alm.puts] == [503, 500, 200]
    assert alm.firmas == 3                                       # la firma puede haber vencido: una por intento
    assert len(nube.esperas) == 2 and nube.esperas[1] > nube.esperas[0] * 0.6


def test_subida_reintenta_si_el_servidor_de_dev_da_409_o_503_al_redesplegar(tmp_path):
    alm = Almacen(guion_op=[409, 503])
    alm.nube(tmp_path).subir("numerada", SID + "1", b"x" * 1000)
    assert alm.ops == ["photo_url"] * 3 and len(alm.puts) == 1


def test_subida_colgada_corta_por_tiempo_y_reintenta(tmp_path, monkeypatch):
    monkeypatch.setattr(modulo, "tiempo_para", lambda n: 0.5)
    alm = Almacen(guion_put=["colgar", 200])
    t0 = time.monotonic()
    alm.nube(tmp_path).subir("original", SID + "1", b"x" * 50_000)
    assert time.monotonic() - t0 < 2.5 and alm.puts[-1][2] == 200


def test_enlace_lento_no_corta_si_el_tiempo_alcanza_para_el_tamano(tmp_path, monkeypatch):
    """Un PUT de 200 KB a 25 KB/s (el hotspot con el audio encima) tarda ~8 s: con 30 s fijos pasaba, pero con
    5 s fijos no. Aquí el tiempo sale del tamaño con un piso de 20 KB/s y la subida termina al primer intento."""
    monkeypatch.setattr(modulo, "TIEMPO_MIN_S", 1.0)
    monkeypatch.setattr(modulo, "PISO_BPS", 20_000)
    alm = Almacen(guion_put=["lento"], bps=100_000)
    nube = alm.nube(tmp_path)
    nube.subir("original", SID + "1", b"x" * 100_000)               # ~1 s a 100 KB/s; tiempo_para = 15 s
    assert len(alm.puts) == 1 and nube.esperas == []


def test_404_no_se_reintenta_y_el_plazo_corta_lo_que_no_se_arregla(tmp_path):
    alm = Almacen(guion_op=[404])
    with pytest.raises(urllib.error.HTTPError):
        alm.nube(tmp_path).subir("original", SID + "1", b"x")
    assert alm.ops == ["photo_url"]
    alm2 = Almacen(guion_put=[503] * 50)
    reloj = [0.0]
    with pytest.raises(urllib.error.HTTPError):
        modulo.con_reintentos("x", lambda: alm2.nube(tmp_path)._subir1("original", SID + "1", b"x"), plazo_s=20,
                              dormir=lambda s: reloj.__setitem__(0, reloj[0] + s), reloj=lambda: reloj[0])
    assert 3 <= len(alm2.puts) <= 6 and reloj[0] < 20


def test_el_log_de_un_fallo_no_lleva_la_url_firmada(tmp_path, capsys):
    alm = Almacen(guion_put=[503, 200])
    alm.nube(tmp_path).subir("original", SID + "1", b"x")
    salida = capsys.readouterr().out
    assert "HTTP 503" in salida and "firma=" not in salida and "127.0.0.1" not in salida


def test_un_corte_al_avisar_photo_done_se_reintenta_y_la_foto_no_queda_fallida(tmp_path):
    alm = Almacen(guion_op=[200, 200, 503])                       # photo_url, photo_url, photo_done 503
    nube = alm.nube(tmp_path)
    o, bus, _, _ = _ojo(tmp_path, nube=nube)
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    assert alm.ops == ["photo_url", "photo_url", "photo_done", "photo_done"]
    assert bus.estados(SID + "1")[-1] == "subida"


def test_si_la_red_no_vuelve_en_el_plazo_reporta_subida(tmp_path):
    alm = Almacen(guion_put=[503] * 50)
    nube = alm.nube(tmp_path, plazo_s=5)
    o, bus, _, _ = _ojo(tmp_path, nube=nube)
    o.atender({"solicitud_id": SID + "1", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    assert alm.ops[-1] == "photo_failed" and bus.estados(SID + "1")[-1] == "error"


def test_limpieza_borra_lo_viejo_y_nada_mas(tmp_path):
    datos = tmp_path / "ojo" / "datos"
    vieja, nueva, cache = datos / "vieja", datos / "nueva", datos / "muse"
    grabaciones = tmp_path / "voz-hermes" / "grabaciones"
    for c in (vieja, nueva, cache, grabaciones):
        c.mkdir(parents=True)
    hace_8 = time.time() - 8 * 86400
    for c in (vieja, cache, grabaciones):
        os.utime(c, (hace_8, hace_8))
    limpiar(datos)
    assert not vieja.exists() and nueva.exists() and cache.exists() and grabaciones.exists()


# ---- Bus y procesos -----------------------------------------------------------------------------------------------

def _puerto():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_bus_propio_convive_con_el_de_la_voz_y_lleva_solo_rutas(tmp_path):
    p_voz, p_ojo = _puerto(), _puerto()
    ctx = zmq.Context.instance()
    voz = ctx.socket(zmq.PUB); voz.setsockopt(zmq.LINGER, 0); voz.bind(f"tcp://127.0.0.1:{p_voz}")      # la voz sigue dueña de su puerto
    bus = BusOjo(pub=f"tcp://127.0.0.1:{p_ojo}", sub=f"tcp://127.0.0.1:{p_voz}")
    sub = ctx.socket(zmq.SUB); sub.setsockopt(zmq.LINGER, 0); sub.setsockopt(zmq.SUBSCRIBE, b""); sub.connect(f"tcp://127.0.0.1:{p_ojo}")
    time.sleep(0.2)
    voz.send_multipart([b"ojo/orden", json.dumps({"solicitud_id": "s"}).encode()])
    assert bus.recibir(1000)["solicitud_id"] == "s"
    o = Ojo(bus, NubeFalsa(), CamaraFalsa(), tmp_path, contar=lambda *a: {"objetos": [caja(20, 20)], "ms": 1})
    o.atender({"solicitud_id": "s", "concepto": "jar", "etiqueta": "f", "foto_id": None})
    time.sleep(0.05)
    crudos = []
    while sub.poll(100):
        crudos.append(sub.recv_multipart()[1])
    assert crudos and all(len(c) < 1000 for c in crudos)                    # sin bytes de imagen
    bus.cerrar(); voz.close(0); sub.close(0)


def _pid_de(puerto):
    r = subprocess.run(["lsof", "-nP", f"-iTCP:{puerto}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True)
    return [int(p) for p in r.stdout.split()]


def _espera(condicion, s=20):
    fin = time.monotonic() + s
    while time.monotonic() < fin:
        if condicion():
            return True
        time.sleep(0.05)
    return False


def test_el_bucle_reinicia_a_ojo_y_no_deja_huerfanos_en_el_puerto(tmp_path):
    puerto = _puerto()
    env = {**os.environ, "ALE_OJO_PYTHON": sys.executable, "ALE_OJO_ESPERA": "0.2", "ALE_BUS_OJO": f"tcp://127.0.0.1:{puerto}", "ALE_BUS": f"tcp://127.0.0.1:{_puerto()}",
           "ALE_CAMARA": f"carpeta:{MANIFIESTO}"}
    bucle = subprocess.Popen([str(AQUI.parent / "ale-robot" / "bucle_ojo.sh")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert _espera(lambda: _pid_de(puerto))
        primero = _pid_de(puerto)
        assert len(primero) == 1
        os.kill(primero[0], signal.SIGKILL)                                 # ojo muere: el bucle sigue
        assert _espera(lambda: _pid_de(puerto) and _pid_de(puerto) != primero)
        assert len(_pid_de(puerto)) == 1
    finally:
        bucle.terminate()
        bucle.wait(5)
    assert _espera(lambda: not _pid_de(puerto), 5)


def test_un_segundo_ojo_no_arranca_con_el_puerto_tomado():
    from bus_ojo import exigir_libre
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); s.listen()
        with pytest.raises(SystemExit):
            exigir_libre(f"tcp://127.0.0.1:{s.getsockname()[1]}")
