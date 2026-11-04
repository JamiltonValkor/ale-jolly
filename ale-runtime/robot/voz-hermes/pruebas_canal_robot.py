"""Pruebas de negocio del canal robot (CR-006) contra un ale-runtime simulado. No suenan: sin micrófono ni parlante.

.venv/bin/python -m pytest pruebas_canal_robot.py -q
"""
import json, socket, threading, time, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import pytest

import canal_robot
from canal_robot import AleRobot, HiloEventos, guardar_env
from cuerpo import bus

TOKEN = "ale_dev_" + "A" * 43


class Simulado:
    """ale-runtime mínimo: emparejamiento (pendiente N veces → emparejado), stream SSE y revocación (401)."""

    def __init__(self, pendientes=2):
        self.pendientes, self.revocado, self.codigos, self.pedidos = pendientes, False, 0, []
        sim = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _json(self, code, cuerpo):
                self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps(cuerpo).encode())

            def do_POST(self):
                cuerpo = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                sim.pedidos.append((self.path, cuerpo, self.headers.get("Authorization")))
                if self.path == "/devices/pairing":
                    sim.codigos += 1
                    return self._json(200, {"pairing_id": "p1", "code": "K7QM-3XPA", "poll_secret": "s" * 43,
                                            "expires_at": "2026-10-30T00:00:00Z", "claim_url": "https://x.test/v?code=K7QM-3XPA"})
                if self.path == "/devices/pairing/p1/poll":
                    if sim.pendientes > 0:
                        sim.pendientes -= 1
                        return self._json(200, {"status": "pending"})
                    sim.revocado = False
                    return self._json(200, {"status": "paired", "device_id": "d1", "device_token": TOKEN})
                if self.path == "/devices/me/stream":
                    if sim.revocado or self.headers.get("Authorization") != f"Bearer {TOKEN}":
                        return self._json(401, {"code": "UNAUTHORIZED"})
                    self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                    for ev, data in (("token", {"text": "¡Hola! "}), ("token", {"text": "¿Vemos tus ventas?"}), ("message_end", {})):
                        self.wfile.write(f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode())
                    return
                self._json(404, {"code": "NOT_FOUND"})

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"


def _robot(tmp_path, monkeypatch, token=""):
    monkeypatch.setattr(canal_robot, "SONDEO_S", 0.01)
    monkeypatch.setenv("ALE_DEVICE_TOKEN", token)
    env = tmp_path / ".env"
    env.write_text("META_API_KEY=m\nCARTESIA_API_KEY=c\n")
    return env


def test_sin_credencial_muestra_codigo_espera_al_dueno_y_guarda_la_credencial(tmp_path, monkeypatch, capsys):
    sim = Simulado(pendientes=2)
    env = _robot(tmp_path, monkeypatch)
    publicado = []
    monkeypatch.setattr(canal_robot.bus, "publicar", lambda tema, **d: publicado.append((tema, d)))
    robot = AleRobot(sim.url, env, nombre="Ale de la oficina")
    robot.preparar()
    assert "K7QM-3XPA" in capsys.readouterr().out
    assert sim.pedidos[0] == ("/devices/pairing", {"name": "Ale de la oficina"}, None)
    estados = [d["estado"] for t, d in publicado if t == "robot/emparejamiento"]
    assert estados.count("mostrando") >= 3 and estados[-1] == "vinculado"   # republicado mientras espera
    assert publicado[0][1]["codigo"] == "K7QM-3XPA" and publicado[0][1]["url"].endswith("code=K7QM-3XPA")
    texto = env.read_text()
    assert f"ALE_DEVICE_TOKEN={TOKEN}" in texto and "ALE_DEVICE_ID=d1" in texto and "META_API_KEY=m" in texto
    assert oct(env.stat().st_mode & 0o777) == "0o600"


def test_con_credencial_no_empareja_y_habla_por_el_canal_robot(tmp_path, monkeypatch):
    sim = Simulado()
    env = _robot(tmp_path, monkeypatch, token=TOKEN)
    robot = AleRobot(sim.url, env)
    robot.preparar()
    assert sim.codigos == 0
    trozos = []
    assert robot.preguntar("Hola Ale", al_token=trozos.append) == "¡Hola! ¿Vemos tus ventas?"
    ruta, cuerpo, auth = sim.pedidos[-1]
    assert (ruta, cuerpo, auth) == ("/devices/me/stream", {"text": "Hola Ale", "voice": True}, f"Bearer {TOKEN}")
    assert trozos == ["¡Hola! ", "¿Vemos tus ventas?"]


def test_desvinculado_borra_la_credencial_se_empareja_otra_vez_y_responde(tmp_path, monkeypatch):
    sim = Simulado(pendientes=0)
    env = _robot(tmp_path, monkeypatch, token="ale_dev_" + "B" * 43)   # credencial vieja (revocada)
    guardar_env(env, {"ALE_DEVICE_TOKEN": "ale_dev_" + "B" * 43})
    robot = AleRobot(sim.url, env)
    robot.preparar()
    assert robot.preguntar("¿Sigues ahí?") == "¡Hola! ¿Vemos tus ventas?"
    assert sim.codigos == 1
    assert f"ALE_DEVICE_TOKEN={TOKEN}" in env.read_text() and "B" * 43 not in env.read_text()


def test_un_segundo_robot_no_arranca_con_el_bus_ocupado():
    with socket.socket() as dueno:
        dueno.bind(("127.0.0.1", 0))
        dueno.listen()
        with mock.patch.object(bus, "DIRECCION", f"tcp://127.0.0.1:{dueno.getsockname()[1]}"), pytest.raises(SystemExit):
            bus.exigir_libre()


class ServidorEventos:
    """Lado servidor de op:events: cada conexión recibe `guion` y se corta; respeta `after` y registra acks."""

    def __init__(self, eventos, estado_http=200, cortes=()):
        self.eventos, self.estado_http, self.cortes = eventos, estado_http, list(cortes)
        self.acks, self.conexiones, self.agentes, self.auth = [], [], [], []
        sim = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                cuerpo = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                sim.agentes.append(self.headers.get("User-Agent"))
                sim.auth.append(self.headers.get("Authorization"))
                if cuerpo.get("op") == "event_ack":
                    sim.acks.append((cuerpo["event_id"], cuerpo["estado"]))
                    self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
                    return
                sim.conexiones.append(cuerpo)
                corte = sim.cortes.pop(0) if sim.cortes else None
                if corte == "muda":                     # abre el SSE y no manda nada: el hotspot ahogado
                    self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                    self.wfile.flush()
                    time.sleep(1.0)
                    return
                if corte:
                    self.send_response(corte); self.send_header("Content-Length", "0"); self.end_headers()
                    return
                if sim.estado_http != 200:
                    self.send_response(sim.estado_http); self.send_header("Content-Length", "0"); self.end_headers()
                    return
                self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                for e in sim.eventos:
                    if e["id"] > cuerpo["after"]:
                        self.wfile.write(f"event: stock\nid: {e['id']}\ndata: {json.dumps(e)}\n\n".encode())
                self.wfile.write(b": keepalive\n\n")

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"


def _foto(i, sid="s1", extra=None):
    return {"id": i, "kind": "foto", "payload": {"solicitud_id": sid, "concepto": "jar", "etiqueta": "frascos", "foto_id": None, **(extra or {})}}


def _esperar(condicion, s=3.0):
    fin = time.monotonic() + s
    while time.monotonic() < fin and not condicion():
        time.sleep(0.01)
    assert condicion()


@pytest.fixture
def ordenes(monkeypatch):
    publicado = []
    monkeypatch.setattr(canal_robot.bus, "publicar", lambda tema, **d: publicado.append((tema, d)))
    monkeypatch.setattr(canal_robot, "RECONEXION_S", (0.01,))
    return publicado


def _hilo(sim, tmp_path, monkeypatch, confirmar=lambda s: True):
    monkeypatch.setenv("ALE_DEVICE_TOKEN", TOKEN)
    env = tmp_path / ".env"
    env.write_text("")
    return HiloEventos(AleRobot(sim.url, env), tmp_path / "cursor", confirmar=confirmar, sub=object())


def test_una_orden_de_foto_llega_al_bus_y_el_cursor_queda_en_disco(tmp_path, monkeypatch, ordenes):
    sim = ServidorEventos([_foto(7)])
    hilo = _hilo(sim, tmp_path, monkeypatch)
    hilo.start()
    _esperar(lambda: sim.acks)
    hilo.parar.set()
    assert ordenes[0] == ("ojo/orden", {"solicitud_id": "s1", "concepto": "jar", "etiqueta": "frascos", "foto_id": None})
    assert sim.acks[0] == (7, "recibido")
    assert (tmp_path / "cursor").read_text() == "7"


def test_al_reiniciar_reconecta_desde_el_cursor_y_no_repite(tmp_path, monkeypatch, ordenes):
    sim = ServidorEventos([_foto(7), _foto(8, "s2")])
    (tmp_path / "cursor").write_text("7")
    hilo = _hilo(sim, tmp_path, monkeypatch)
    hilo.start()
    _esperar(lambda: len(sim.conexiones) >= 3)
    hilo.parar.set()
    assert sim.conexiones[0]["after"] == 7
    assert sim.conexiones[-1]["after"] == 8                 # reconexión con el cursor nuevo
    assert [d["solicitud_id"] for _, d in ordenes] == ["s2"]


def test_sin_respuesta_de_ojo_no_confirma_y_la_reentrega_vuelve_a_intentar(tmp_path, monkeypatch, ordenes):
    respuestas = iter([False, True])
    sim = ServidorEventos([_foto(7)])
    hilo = _hilo(sim, tmp_path, monkeypatch, confirmar=lambda s: next(respuestas, True))
    hilo.start()
    _esperar(lambda: sim.acks)
    hilo.parar.set()
    assert sim.conexiones[1]["after"] == 0                  # el cursor no avanzó con la primera
    assert sim.acks == [(7, "recibido")] and len(ordenes) >= 2


def test_con_la_red_muda_o_el_servidor_redesplegando_se_reconecta_solo_y_entrega_la_foto(tmp_path, monkeypatch, ordenes, capsys):
    """Pi despierta: el SSE queda abierto sin keepalive (TimeoutError), luego dev redespliega (503, 409). El hilo
    sigue vivo, reconecta sin intervención y la foto pendiente llega a `ojo` una sola vez."""
    monkeypatch.setattr(canal_robot, "LECTURA_S", 0.3)
    sim = ServidorEventos([_foto(7)], cortes=["muda", 503, 409])
    hilo = _hilo(sim, tmp_path, monkeypatch)
    hilo.start()
    _esperar(lambda: sim.acks, s=5)
    hilo.parar.set()
    assert len(sim.conexiones) == 4 and all(c["after"] == 0 for c in sim.conexiones)
    assert sim.acks == [(7, "recibido")] and [t for t, _ in ordenes] == ["ojo/orden"]
    salida = capsys.readouterr().out
    assert "conexión perdida (TimeoutError)" in salida and "respondió 503" in salida and "respondió 409" in salida


def test_evento_reentregado_ya_confirmado_no_toma_otra_foto(tmp_path, monkeypatch, ordenes):
    sim = ServidorEventos([])
    hilo = _hilo(sim, tmp_path, monkeypatch)
    hilo._evento(json.dumps(_foto(7)))
    hilo._evento(json.dumps(_foto(7, extra={"reentrega": True})))
    assert len([t for t, _ in ordenes if t == "ojo/orden"]) == 1


def test_con_401_no_empareja_y_espera_el_token_del_hilo_principal(tmp_path, monkeypatch, ordenes):
    sim = ServidorEventos([], estado_http=401)
    hilo = _hilo(sim, tmp_path, monkeypatch)
    emparejo = mock.Mock()
    hilo.robot.emparejar = emparejo
    hilo.start()
    _esperar(lambda: sim.conexiones)
    time.sleep(0.05)
    assert len(sim.conexiones) == 1 and not emparejo.called and "ALE_DEVICE" not in hilo.robot.env.read_text()
    sim.estado_http = 200
    hilo.robot.token = "ale_dev_" + "C" * 43
    hilo.parar.wait(0)
    _esperar(lambda: len(sim.conexiones) >= 2, s=3)
    hilo.parar.set()
    assert sim.auth[-1] == f"Bearer {hilo.robot.token}"


def test_usa_req_con_credencial_y_nunca_el_agente_de_urllib(tmp_path, monkeypatch, ordenes):
    sim = ServidorEventos([_foto(7)])
    hilo = _hilo(sim, tmp_path, monkeypatch)
    hilo.start()
    _esperar(lambda: sim.acks)
    hilo.parar.set()
    assert all(a and "urllib" not in a.lower() for a in sim.agentes)
    assert set(sim.auth) == {f"Bearer {TOKEN}"}


def test_arranca_tras_preparar_solo_con_la_variable(tmp_path, monkeypatch, ordenes):
    sim = Simulado()
    env = _robot(tmp_path, monkeypatch, token=TOKEN)
    iniciados = []
    monkeypatch.setattr(canal_robot.HiloEventos, "start", lambda self: iniciados.append(self))
    monkeypatch.delenv("ALE_EVENTOS", raising=False)
    AleRobot(sim.url, env).preparar()
    assert iniciados == []
    monkeypatch.setenv("ALE_EVENTOS", "1")
    AleRobot(sim.url, env).preparar()
    assert len(iniciados) == 1 and iniciados[0].ruta_cursor == tmp_path / ".eventos-cursor"
